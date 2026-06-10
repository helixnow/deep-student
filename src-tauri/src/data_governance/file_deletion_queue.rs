//! Local deletion queues for file-level cloud sync.
//!
//! These helpers are intentionally small and best-effort. File deletion should
//! not fail just because an older local database has not run the queue
//! migrations yet; the next migrated sync run will pick up future deletes.

use rusqlite::{params, Connection};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

fn open_queue_connection(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
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

pub(crate) fn enqueue_asset_deletion(
    active_dir: &Path,
    key: &str,
    size: Option<u64>,
) -> rusqlite::Result<()> {
    let db_path = active_dir.join("databases").join("vfs.db");
    let conn = open_queue_connection(&db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO __asset_deletion_queue (key, size, deleted_at, retry_count)
         VALUES (?1, ?2, datetime('now'), 0)",
        params![key, size.map(|s| s as i64)],
    )?;
    Ok(())
}

pub(crate) fn enqueue_workspace_deletion(
    conn: &Connection,
    workspace_id: &str,
    size: Option<u64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO __workspace_deletion_queue (workspace_id, size, deleted_at, retry_count)
         VALUES (?1, ?2, datetime('now'), 0)",
        params![workspace_id, size.map(|s| s as i64)],
    )?;
    Ok(())
}
