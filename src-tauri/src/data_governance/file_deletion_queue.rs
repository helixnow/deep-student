//! Durable local deletion intents for file-level cloud sync.
//!
//! A deletion is first committed as `prepared`, the physical file is then
//! removed, and finally the historical sync queue is populated while the
//! journal advances to `ready`.  The queue remains a ready-only compatibility
//! outbox; its DELETE trigger advances the journal to `published`.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub(crate) enum DeletionJournalError {
    #[error("删除意图数据库错误: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("删除意图文件错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("删除意图路径非法: {0}")]
    InvalidPath(String),
    #[error(
        "删除意图内容冲突: operation_id={operation_id}, path={path}, expected={expected}, actual={actual}"
    )]
    Conflict {
        operation_id: String,
        path: String,
        expected: String,
        actual: String,
    },
    #[error("operation_id 已用于其他删除意图: {0}")]
    DuplicateOperation(String),
    #[error("删除意图状态错误: {0}")]
    InvalidState(String),
    #[error("删除意图必须在独立 SQLite 事务中准备")]
    TransactionBoundary,
}

type JournalResult<T> = Result<T, DeletionJournalError>;

#[derive(Debug, Clone)]
pub(crate) struct PreparedDeletionIntent {
    pub operation_id: String,
    pub entity_key: String,
    pub local_path: String,
    pub expected_hash: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Asset,
    Workspace,
}

impl TargetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Workspace => "workspace",
        }
    }
}

fn open_queue_connection(path: &Path) -> JournalResult<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    Ok(conn)
}

pub(crate) fn active_data_dir_from_runtime_base(runtime_base: &Path) -> PathBuf {
    crate::data_space::get_data_space_manager()
        .map(|mgr| mgr.active_dir())
        .unwrap_or_else(|| runtime_base.to_path_buf())
}

pub(crate) fn asset_key_from_relative_path(relative_path: &str) -> Option<String> {
    let normalized = relative_path.trim().replace('\\', "/");
    let normalized = normalized.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() {
        return None;
    }

    let rel_path = Path::new(normalized);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }

    if normalized.starts_with("active/") || normalized.starts_with("app_data/") {
        return Some(normalized.to_string());
    }

    if normalized == "pdf_ocr_sessions" || normalized.starts_with("pdf_ocr_sessions/") {
        Some(format!("app_data/{}", normalized))
    } else {
        Some(format!("active/{}", normalized))
    }
}

pub(crate) fn asset_local_path_from_key(key: &str) -> JournalResult<PathBuf> {
    let local = key
        .strip_prefix("active/")
        .or_else(|| key.strip_prefix("app_data/"))
        .ok_or_else(|| {
            DeletionJournalError::InvalidPath(format!("资产 key 不在本地命名空间: {}", key))
        })?;
    validate_relative_path(Path::new(local))?;
    Ok(PathBuf::from(local))
}

pub(crate) fn delete_asset_with_journal(
    active_dir: &Path,
    key: &str,
    local_path: &Path,
) -> JournalResult<bool> {
    let db_path = active_dir.join("databases").join("vfs.db");
    let conn = open_queue_connection(&db_path)?;

    recover_prepared_intents(&conn, TargetKind::Asset, active_dir)?;

    let absolute_path = resolve_local_path(active_dir, local_path)?;
    if !absolute_path.try_exists()? {
        return Ok(false);
    }
    let intent = prepare_asset_deletion_with_conn(&conn, active_dir, key, local_path)?;
    finish_asset_deletion_with_conn(&conn, active_dir, &intent)?;
    Ok(true)
}

/// 在调用方的 SQLite 事务中持久化资产删除意图。
///
/// 该函数刻意不要求 autocommit：需要删除业务元数据的调用方应先开启
/// SAVEPOINT/transaction，在同一事务中调用本函数并删除元数据，提交成功后再
/// 调用 [`finish_asset_deletion_with_conn`] 触碰物理文件。
pub(crate) fn prepare_asset_deletion_with_conn(
    conn: &Connection,
    active_dir: &Path,
    key: &str,
    local_path: &Path,
) -> JournalResult<PreparedDeletionIntent> {
    let expected_local_path = asset_local_path_from_key(key)?;
    if expected_local_path != local_path {
        return Err(DeletionJournalError::InvalidPath(format!(
            "资产 key 与本地路径不匹配: key={}, path={}",
            key,
            local_path.display()
        )));
    }

    let absolute_path = resolve_local_path(active_dir, local_path)?;
    let (expected_hash, size) = if absolute_path.try_exists()? {
        ensure_regular_file(active_dir, &absolute_path)?;
        (
            Some(hash_file(&absolute_path)?),
            Some(fs::metadata(&absolute_path)?.len()),
        )
    } else {
        // 业务元数据仍可能引用一个已丢失的本地文件。删除意图必须继续进入
        // outbox，才能清除其他设备/远端仍存在的副本。
        (None, None)
    };

    insert_prepared_intent(
        conn,
        TargetKind::Asset,
        key,
        &path_to_storage(local_path)?,
        expected_hash.as_deref(),
        size,
        &uuid::Uuid::new_v4().to_string(),
    )
}

pub(crate) fn finish_asset_deletion_with_conn(
    conn: &Connection,
    active_dir: &Path,
    intent: &PreparedDeletionIntent,
) -> JournalResult<()> {
    finish_prepared_intent(conn, TargetKind::Asset, active_dir, intent)
}

pub(crate) fn recover_asset_deletions(active_dir: &Path) -> JournalResult<usize> {
    let db_path = active_dir.join("databases").join("vfs.db");
    let conn = open_queue_connection(&db_path)?;
    recover_prepared_intents(&conn, TargetKind::Asset, active_dir)
}

pub(crate) fn recover_workspace_deletions(
    conn: &Connection,
    workspaces_dir: &Path,
) -> JournalResult<usize> {
    ensure_autocommit(conn)?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    recover_prepared_intents(conn, TargetKind::Workspace, workspaces_dir)
}

/// Atomically stores `prepared` and removes workspace metadata.  The caller
/// must only delete the database file after this function returns.
pub(crate) fn prepare_workspace_deletion(
    conn: &Connection,
    workspaces_dir: &Path,
    workspace_id: &str,
) -> JournalResult<PreparedDeletionIntent> {
    ensure_autocommit(conn)?;
    conn.pragma_update(None, "synchronous", "FULL")?;

    let local_path = PathBuf::from(format!("ws_{}.db", workspace_id));
    validate_relative_path(&local_path)?;
    let absolute_path = resolve_local_path(workspaces_dir, &local_path)?;
    let (expected_hash, size) = if absolute_path.try_exists()? {
        ensure_regular_file(workspaces_dir, &absolute_path)?;
        (
            Some(hash_file(&absolute_path)?),
            Some(fs::metadata(&absolute_path)?.len()),
        )
    } else {
        (None, None)
    };
    let operation_id = uuid::Uuid::new_v4().to_string();
    let stored_path = path_to_storage(&local_path)?;

    conn.execute_batch("SAVEPOINT workspace_deletion_prepare")?;
    let result = (|| -> JournalResult<PreparedDeletionIntent> {
        let intent = insert_prepared_intent(
            conn,
            TargetKind::Workspace,
            workspace_id,
            &stored_path,
            expected_hash.as_deref(),
            size,
            &operation_id,
        )?;
        conn.execute(
            "DELETE FROM workspace_index WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(intent)
    })();

    match result {
        Ok(intent) => {
            conn.execute_batch("RELEASE SAVEPOINT workspace_deletion_prepare")?;
            Ok(intent)
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT workspace_deletion_prepare;
                 RELEASE SAVEPOINT workspace_deletion_prepare;",
            );
            Err(error)
        }
    }
}

pub(crate) fn finish_workspace_deletion(
    conn: &Connection,
    workspaces_dir: &Path,
    intent: &PreparedDeletionIntent,
) -> JournalResult<()> {
    finish_prepared_intent(conn, TargetKind::Workspace, workspaces_dir, intent)
}

/// A recreated workspace supersedes already-ready deletion tombstones.  This is
/// deliberately separate from prepared recovery: callers must recover first,
/// then create/open the replacement database, then cancel stale ready entries.
pub(crate) fn cancel_ready_workspace_deletion(
    conn: &Connection,
    workspace_id: &str,
) -> JournalResult<()> {
    ensure_autocommit(conn)?;
    conn.execute_batch("SAVEPOINT workspace_deletion_recreated")?;
    let result = (|| -> JournalResult<()> {
        conn.execute(
            "UPDATE __file_deletion_journal
                SET state = 'cancelled',
                    cancelled_at = ?2,
                    last_error = 'workspace recreated before deletion was published'
              WHERE target_kind = 'workspace'
                AND entity_key = ?1
                AND state = 'ready'",
            params![workspace_id, now()],
        )?;
        conn.execute(
            "DELETE FROM __workspace_deletion_queue WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT workspace_deletion_recreated")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT workspace_deletion_recreated;
                 RELEASE SAVEPOINT workspace_deletion_recreated;",
            );
            Err(error)
        }
    }
}

fn ensure_autocommit(conn: &Connection) -> JournalResult<()> {
    if conn.is_autocommit() {
        Ok(())
    } else {
        Err(DeletionJournalError::TransactionBoundary)
    }
}

fn insert_prepared_intent(
    conn: &Connection,
    target_kind: TargetKind,
    entity_key: &str,
    local_path: &str,
    expected_hash: Option<&str>,
    size: Option<u64>,
    operation_id: &str,
) -> JournalResult<PreparedDeletionIntent> {
    let prepared_at = now();
    conn.execute(
        "INSERT INTO __file_deletion_journal (
             operation_id, target_kind, entity_key, local_path, expected_hash,
             size, state, prepared_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7)
         ON CONFLICT(operation_id) DO NOTHING",
        params![
            operation_id,
            target_kind.as_str(),
            entity_key,
            local_path,
            expected_hash,
            size.map(|value| value as i64),
            prepared_at
        ],
    )?;

    let existing = conn
        .query_row(
            "SELECT target_kind, entity_key, local_path, expected_hash, size
               FROM __file_deletion_journal
              WHERE operation_id = ?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?;

    let expected_tuple = (
        target_kind.as_str(),
        entity_key,
        local_path,
        expected_hash,
        size.map(|value| value as i64),
    );
    match existing {
        Some((kind, key, path, hash, stored_size))
            if (
                kind.as_str(),
                key.as_str(),
                path.as_str(),
                hash.as_deref(),
                stored_size,
            ) == expected_tuple =>
        {
            Ok(PreparedDeletionIntent {
                operation_id: operation_id.to_string(),
                entity_key: entity_key.to_string(),
                local_path: local_path.to_string(),
                expected_hash: expected_hash.map(str::to_string),
                size,
            })
        }
        _ => Err(DeletionJournalError::DuplicateOperation(
            operation_id.to_string(),
        )),
    }
}

fn recover_prepared_intents(
    conn: &Connection,
    target_kind: TargetKind,
    root: &Path,
) -> JournalResult<usize> {
    ensure_autocommit(conn)?;
    let mut statement = conn.prepare(
        "SELECT operation_id, entity_key, local_path, expected_hash, size
           FROM __file_deletion_journal
          WHERE target_kind = ?1 AND state = 'prepared'
          ORDER BY prepared_at, operation_id",
    )?;
    let intents = statement
        .query_map(params![target_kind.as_str()], |row| {
            let size = row.get::<_, Option<i64>>(4)?;
            Ok(PreparedDeletionIntent {
                operation_id: row.get(0)?,
                entity_key: row.get(1)?,
                local_path: row.get(2)?,
                expected_hash: row.get(3)?,
                size: size.and_then(|value| u64::try_from(value).ok()),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let mut recovered = 0;
    for intent in intents {
        finish_prepared_intent(conn, target_kind, root, &intent)?;
        recovered += 1;
    }
    Ok(recovered)
}

fn finish_prepared_intent(
    conn: &Connection,
    target_kind: TargetKind,
    root: &Path,
    intent: &PreparedDeletionIntent,
) -> JournalResult<()> {
    ensure_autocommit(conn)?;
    let local_path = Path::new(&intent.local_path);
    let absolute_path = resolve_local_path(root, local_path)?;
    let quarantine_path = deletion_quarantine_path(&absolute_path, &intent.operation_id)?;

    // Atomic rename closes the check/delete race: a concurrent writer may
    // recreate `absolute_path`, but recovery only ever deletes this
    // operation's deterministic quarantine file.
    let deletion_path = if quarantine_path.try_exists()? {
        Some(quarantine_path)
    } else if absolute_path.try_exists()? {
        ensure_regular_file(root, &absolute_path)?;
        verify_expected_hash(conn, intent, &absolute_path)?;
        fs::rename(&absolute_path, &quarantine_path)?;
        Some(quarantine_path)
    } else {
        None
    };

    if target_kind == TargetKind::Workspace {
        remove_workspace_sidecars(root, &absolute_path)?;
    }

    if let Some(deletion_path) = deletion_path {
        if deletion_path.try_exists()? {
            ensure_regular_file(root, &deletion_path)?;
            verify_expected_hash(conn, intent, &deletion_path)?;
            fs::remove_file(&deletion_path)?;
        }
    }

    mark_ready(conn, target_kind, intent)
}

fn remove_workspace_sidecars(root: &Path, database_path: &Path) -> JournalResult<()> {
    for extension in ["db-wal", "db-shm"] {
        let sidecar = database_path.with_extension(extension);
        if sidecar.try_exists()? {
            ensure_regular_file(root, &sidecar)?;
            fs::remove_file(&sidecar)?;
        }
    }
    Ok(())
}

fn verify_expected_hash(
    conn: &Connection,
    intent: &PreparedDeletionIntent,
    path: &Path,
) -> JournalResult<()> {
    let actual_hash = hash_file(path)?;
    match intent.expected_hash.as_deref() {
        Some(expected_hash) if actual_hash == expected_hash => Ok(()),
        Some(expected_hash) => cancel_conflict(conn, intent, path, expected_hash, &actual_hash),
        None => cancel_conflict(conn, intent, path, "<missing baseline>", &actual_hash),
    }
}

fn deletion_quarantine_path(path: &Path, operation_id: &str) -> JournalResult<PathBuf> {
    let file_name = path.file_name().ok_or_else(|| {
        DeletionJournalError::InvalidPath(format!("删除目标缺少文件名: {}", path.display()))
    })?;
    let file_name = file_name.to_str().ok_or_else(|| {
        DeletionJournalError::InvalidPath(format!("删除目标文件名不是 UTF-8: {}", path.display()))
    })?;
    Ok(path.with_file_name(format!("{}.deleting-{}", file_name, operation_id)))
}

fn mark_ready(
    conn: &Connection,
    target_kind: TargetKind,
    intent: &PreparedDeletionIntent,
) -> JournalResult<()> {
    let ready_at = now();
    conn.execute_batch("SAVEPOINT file_deletion_ready")?;
    let result = (|| -> JournalResult<()> {
        match target_kind {
            TargetKind::Asset => {
                conn.execute(
                    "INSERT INTO __asset_deletion_queue (key, size, deleted_at, retry_count)
                     VALUES (?1, ?2, ?3, 0)
                     ON CONFLICT(key) DO UPDATE SET
                         size = excluded.size,
                         deleted_at = excluded.deleted_at,
                         retry_count = 0",
                    params![
                        intent.entity_key,
                        intent.size.map(|value| value as i64),
                        ready_at
                    ],
                )?;
            }
            TargetKind::Workspace => {
                conn.execute(
                    "INSERT INTO __workspace_deletion_queue (
                         workspace_id, size, deleted_at, retry_count
                     ) VALUES (?1, ?2, ?3, 0)
                     ON CONFLICT(workspace_id) DO UPDATE SET
                         size = excluded.size,
                         deleted_at = excluded.deleted_at,
                         retry_count = 0",
                    params![
                        intent.entity_key,
                        intent.size.map(|value| value as i64),
                        ready_at
                    ],
                )?;
            }
        }
        let updated = conn.execute(
            "UPDATE __file_deletion_journal
                SET state = 'ready',
                    ready_at = ?2,
                    last_error = NULL
              WHERE operation_id = ?1
                AND state IN ('prepared', 'ready')",
            params![intent.operation_id, ready_at],
        )?;
        if updated != 1 {
            return Err(DeletionJournalError::InvalidState(format!(
                "operation {} 无法推进到 ready",
                intent.operation_id
            )));
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT file_deletion_ready")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT file_deletion_ready;
                 RELEASE SAVEPOINT file_deletion_ready;",
            );
            Err(error)
        }
    }
}

fn cancel_conflict(
    conn: &Connection,
    intent: &PreparedDeletionIntent,
    path: &Path,
    expected: &str,
    actual: &str,
) -> JournalResult<()> {
    let message = format!(
        "file content changed after prepare: expected={}, actual={}",
        expected, actual
    );
    conn.execute(
        "UPDATE __file_deletion_journal
            SET state = 'cancelled',
                cancelled_at = ?2,
                last_error = ?3
          WHERE operation_id = ?1 AND state = 'prepared'",
        params![intent.operation_id, now(), message],
    )?;
    Err(DeletionJournalError::Conflict {
        operation_id: intent.operation_id.clone(),
        path: path.display().to_string(),
        expected: expected.to_string(),
        actual: actual.to_string(),
    })
}

fn ensure_regular_file(root: &Path, path: &Path) -> JournalResult<()> {
    let canonical_root = fs::canonicalize(root)?;
    let canonical_path = fs::canonicalize(path)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(DeletionJournalError::InvalidPath(format!(
            "{} 越过允许根目录 {}",
            canonical_path.display(),
            canonical_root.display()
        )));
    }
    if !canonical_path.is_file() {
        return Err(DeletionJournalError::InvalidPath(format!(
            "{} 不是普通文件",
            canonical_path.display()
        )));
    }
    Ok(())
}

fn resolve_local_path(root: &Path, local_path: &Path) -> JournalResult<PathBuf> {
    validate_relative_path(local_path)?;
    Ok(root.join(local_path))
}

fn validate_relative_path(path: &Path) -> JournalResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(DeletionJournalError::InvalidPath(
            path.display().to_string(),
        ));
    }
    Ok(())
}

fn path_to_storage(path: &Path) -> JournalResult<String> {
    validate_relative_path(path)?;
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| DeletionJournalError::InvalidPath(path.display().to_string()))
}

pub(crate) fn hash_file(path: &Path) -> JournalResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_vfs_journal() -> (TempDir, PathBuf) {
        let temp = TempDir::new().unwrap();
        let active_dir = temp.path().join("active");
        fs::create_dir_all(active_dir.join("databases")).unwrap();
        let conn = Connection::open(active_dir.join("databases/vfs.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE __blob_deletion_queue (
                 hash TEXT PRIMARY KEY,
                 relative_path TEXT,
                 size INTEGER,
                 deleted_at TEXT NOT NULL,
                 retry_count INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE __asset_deletion_queue (
                 key TEXT PRIMARY KEY,
                 size INTEGER,
                 deleted_at TEXT NOT NULL,
                 retry_count INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        conn.execute_batch(include_str!(
            "../../migrations/vfs/V20260808__file_deletion_intent_journal.sql"
        ))
        .unwrap();
        (temp, active_dir)
    }

    fn prepare_asset(
        active_dir: &Path,
        operation_id: &str,
        key: &str,
        local_path: &str,
    ) -> PreparedDeletionIntent {
        let path = active_dir.join(local_path);
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        insert_prepared_intent(
            &conn,
            TargetKind::Asset,
            key,
            local_path,
            Some(&hash_file(&path).unwrap()),
            Some(fs::metadata(path).unwrap().len()),
            operation_id,
        )
        .unwrap()
    }

    #[test]
    fn recovers_crash_after_prepare() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        let file = active_dir.join("notes_assets/a.bin");
        fs::write(&file, b"baseline").unwrap();
        prepare_asset(
            &active_dir,
            "op-prepared-crash",
            "active/notes_assets/a.bin",
            "notes_assets/a.bin",
        );

        assert_eq!(recover_asset_deletions(&active_dir).unwrap(), 1);
        assert!(!file.exists());
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        let state: String = conn
            .query_row(
                "SELECT state FROM __file_deletion_journal WHERE operation_id = ?1",
                ["op-prepared-crash"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn recovers_crash_after_file_delete() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        let file = active_dir.join("notes_assets/a.bin");
        fs::write(&file, b"baseline").unwrap();
        prepare_asset(
            &active_dir,
            "op-delete-crash",
            "active/notes_assets/a.bin",
            "notes_assets/a.bin",
        );
        fs::remove_file(&file).unwrap();

        assert_eq!(recover_asset_deletions(&active_dir).unwrap(), 1);
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __asset_deletion_queue
                  WHERE key = 'active/notes_assets/a.bin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1);
    }

    #[test]
    fn ready_outbox_failure_is_visible_and_recoverable() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        let file = active_dir.join("notes_assets/a.bin");
        fs::write(&file, b"baseline").unwrap();
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_asset_outbox
             BEFORE INSERT ON __asset_deletion_queue
             BEGIN
                 SELECT RAISE(FAIL, 'injected outbox failure');
             END;",
        )
        .unwrap();
        drop(conn);

        let error = delete_asset_with_journal(
            &active_dir,
            "active/notes_assets/a.bin",
            Path::new("notes_assets/a.bin"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("injected outbox failure"));
        assert!(!file.exists(), "physical deletion already completed");

        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        conn.execute_batch("DROP TRIGGER fail_asset_outbox")
            .unwrap();
        drop(conn);
        assert_eq!(recover_asset_deletions(&active_dir).unwrap(), 1);
    }

    #[test]
    fn changed_content_cancels_recovery() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        let file = active_dir.join("notes_assets/a.bin");
        fs::write(&file, b"baseline").unwrap();
        prepare_asset(
            &active_dir,
            "op-conflict",
            "active/notes_assets/a.bin",
            "notes_assets/a.bin",
        );
        fs::write(&file, b"changed").unwrap();

        assert!(matches!(
            recover_asset_deletions(&active_dir),
            Err(DeletionJournalError::Conflict { .. })
        ));
        assert_eq!(fs::read(&file).unwrap(), b"changed");
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        let state: String = conn
            .query_row(
                "SELECT state FROM __file_deletion_journal WHERE operation_id = 'op-conflict'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "cancelled");
    }

    #[test]
    fn duplicate_operation_id_is_idempotent_only_for_same_intent() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        fs::write(active_dir.join("notes_assets/a.bin"), b"baseline").unwrap();
        let first = prepare_asset(
            &active_dir,
            "op-duplicate",
            "active/notes_assets/a.bin",
            "notes_assets/a.bin",
        );
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        let repeated = insert_prepared_intent(
            &conn,
            TargetKind::Asset,
            &first.entity_key,
            &first.local_path,
            first.expected_hash.as_deref(),
            first.size,
            &first.operation_id,
        )
        .unwrap();
        assert_eq!(repeated.operation_id, first.operation_id);

        let error = insert_prepared_intent(
            &conn,
            TargetKind::Asset,
            "active/notes_assets/other.bin",
            "notes_assets/other.bin",
            Some("different"),
            Some(1),
            &first.operation_id,
        )
        .unwrap_err();
        assert!(matches!(error, DeletionJournalError::DuplicateOperation(_)));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __file_deletion_journal
                  WHERE operation_id = 'op-duplicate'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn prepared_asset_intent_rolls_back_with_business_metadata() {
        let (_temp, active_dir) = setup_vfs_journal();
        fs::create_dir_all(active_dir.join("notes_assets")).unwrap();
        let file = active_dir.join("notes_assets/a.bin");
        fs::write(&file, b"baseline").unwrap();
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE note_asset_metadata (key TEXT PRIMARY KEY);
             INSERT INTO note_asset_metadata(key) VALUES ('active/notes_assets/a.bin');
             SAVEPOINT metadata_and_deletion_intent;",
        )
        .unwrap();

        prepare_asset_deletion_with_conn(
            &conn,
            &active_dir,
            "active/notes_assets/a.bin",
            Path::new("notes_assets/a.bin"),
        )
        .unwrap();
        conn.execute(
            "DELETE FROM note_asset_metadata WHERE key = ?1",
            ["active/notes_assets/a.bin"],
        )
        .unwrap();
        conn.execute_batch(
            "ROLLBACK TO SAVEPOINT metadata_and_deletion_intent;
             RELEASE SAVEPOINT metadata_and_deletion_intent;",
        )
        .unwrap();

        let metadata_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_asset_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        let journal_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM __file_deletion_journal", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(metadata_count, 1);
        assert_eq!(journal_count, 0);
        assert!(file.exists());
    }

    #[test]
    fn missing_local_asset_still_produces_ready_remote_deletion() {
        let (_temp, active_dir) = setup_vfs_journal();
        let conn = Connection::open(active_dir.join("databases").join("vfs.db")).unwrap();
        let intent = prepare_asset_deletion_with_conn(
            &conn,
            &active_dir,
            "active/notes_assets/missing.bin",
            Path::new("notes_assets/missing.bin"),
        )
        .unwrap();
        assert!(intent.expected_hash.is_none());

        finish_asset_deletion_with_conn(&conn, &active_dir, &intent).unwrap();
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM __asset_deletion_queue
                  WHERE key = 'active/notes_assets/missing.bin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1);
    }
}
