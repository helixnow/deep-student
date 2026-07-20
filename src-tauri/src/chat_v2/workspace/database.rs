use chrono::Utc;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::types::WorkspaceId;

pub type WorkspaceDatabasePool = Pool<SqliteConnectionManager>;
pub type WorkspacePooledConnection = PooledConnection<SqliteConnectionManager>;

const WORKSPACE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    creator_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS agent (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    skill_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    joined_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_workspace ON agent(workspace_id, status);

CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    sender_session_id TEXT NOT NULL,
    target_session_id TEXT,
    message_type TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_workspace_time ON message(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_target ON message(target_session_id, status);

CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unread',
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox(session_id, status, id);

CREATE TABLE IF NOT EXISTS document (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_workspace ON document(workspace_id);

CREATE TABLE IF NOT EXISTS context (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key),
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);

-- 睡眠块表：主代理睡眠/唤醒机制
CREATE TABLE IF NOT EXISTS sleep_block (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    awaiting_agents TEXT NOT NULL DEFAULT '[]',
    wake_condition TEXT NOT NULL DEFAULT 'result_message',
    status TEXT NOT NULL DEFAULT 'sleeping',
    timeout_at TEXT,
    created_at TEXT NOT NULL,
    awakened_at TEXT,
    awakened_by TEXT,
    awaken_message TEXT,
    message_id TEXT,
    block_id TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sleep_block_workspace ON sleep_block(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_coordinator ON sleep_block(coordinator_session_id, status);

-- 子代理任务表：用于重启后恢复
CREATE TABLE IF NOT EXISTS subagent_task (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    skill_id TEXT,
    initial_task TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    result_summary TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_session_id) REFERENCES agent(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subagent_task_workspace ON subagent_task(workspace_id, status);
"#;

const CURRENT_SCHEMA_VERSION: i32 = 2;

/// workspace_id 允许的最大长度（正常 id 形如 `ws_{ULID}`，26 位 ULID + 前缀 ≈ 29 字符）
const WORKSPACE_ID_MAX_LEN: usize = 128;

/// P0 安全：workspace_id 会被直接拼进数据库文件名（`ws_{id}.db`），
/// 必须先做白名单校验，拒绝路径分隔符、`..`、空字节等可构造逃逸路径的输入。
///
/// 合法格式：1..=128 个 `[A-Za-z0-9_-]` 字符。正常生成路径
/// （`Workspace::generate_id` -> `ws_{ULID}`）天然满足；此校验用于封死
/// 上层误传/恶意构造 id 的信任边界缺口。
pub fn validate_workspace_id(workspace_id: &str) -> Result<(), String> {
    if workspace_id.is_empty() || workspace_id.len() > WORKSPACE_ID_MAX_LEN {
        return Err(format!(
            "Invalid workspace_id length {} (expected 1..={})",
            workspace_id.len(),
            WORKSPACE_ID_MAX_LEN
        ));
    }
    if !workspace_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "Invalid workspace_id {:?}: only [A-Za-z0-9_-] characters are allowed",
            workspace_id
        ));
    }
    Ok(())
}

fn migrate_schema(conn: &Connection) -> Result<(), String> {
    let current_version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read user_version: {}", e))?;

    if current_version < 1 {
        // V1: initial schema — tables already created via WORKSPACE_SCHEMA above.
        // Future migrations go here as additional version checks.
    }

    if current_version < 2 {
        // V2: align subagent_task schema with runtime query contract.
        // Old databases may only contain task_content/last_active_at/needs_recovery.
        let _ = conn.execute("ALTER TABLE subagent_task ADD COLUMN initial_task TEXT", []);
        let _ = conn.execute("ALTER TABLE subagent_task ADD COLUMN started_at TEXT", []);
        let _ = conn.execute("ALTER TABLE subagent_task ADD COLUMN completed_at TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE subagent_task ADD COLUMN result_summary TEXT",
            [],
        );
        let has_task_content: bool = conn
            .prepare("PRAGMA table_info(subagent_task)")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                let mut found = false;
                for col in rows.flatten() {
                    if col == "task_content" {
                        found = true;
                        break;
                    }
                }
                Ok(found)
            })
            .unwrap_or(false);
        if has_task_content {
            conn.execute(
                "UPDATE subagent_task SET initial_task = task_content WHERE initial_task IS NULL",
                [],
            )
            .map_err(|e| format!("Migration V2 failed while backfilling initial_task: {}", e))?;
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_subagent_task_workspace ON subagent_task(workspace_id, status)",
            [],
        )
        .map_err(|e| format!("Migration V2 failed while ensuring index: {}", e))?;
    }

    if current_version < CURRENT_SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
            .map_err(|e| format!("Failed to update user_version: {}", e))?;
        log::info!(
            "[WorkspaceDatabase] Schema migrated from v{} to v{}",
            current_version,
            CURRENT_SCHEMA_VERSION
        );
    }

    Ok(())
}

#[derive(Debug)]
pub struct WorkspaceDatabase {
    workspace_id: WorkspaceId,
    db_path: PathBuf,
    pool: std::sync::RwLock<WorkspaceDatabasePool>,
    maintenance_mode: std::sync::atomic::AtomicBool,
}

impl WorkspaceDatabase {
    pub fn new(workspaces_dir: &Path, workspace_id: &str) -> Result<Self, String> {
        validate_workspace_id(workspace_id)?;
        std::fs::create_dir_all(workspaces_dir)
            .map_err(|e| format!("Failed to create workspaces directory: {}", e))?;

        let db_path = workspaces_dir.join(format!("ws_{}.db", workspace_id));

        // 🔧 批判性修复：检测数据库损坏并尝试恢复
        if db_path.exists() {
            let check_result = Connection::open(&db_path).and_then(|conn| {
                conn.query_row("PRAGMA quick_check;", [], |row| row.get::<_, String>(0))
            });
            match check_result {
                Ok(result) if result != "ok" => {
                    let timestamp = Utc::now().format("%Y%m%d%H%M%S");
                    let corrupt_path = workspaces_dir
                        .join(format!("ws_{}.db.corrupt-{}", workspace_id, timestamp));
                    log::warn!(
                        "[WorkspaceDatabase] integrity_check failed ({}), moving corrupt db to {:?}",
                        result,
                        corrupt_path
                    );
                    std::fs::rename(&db_path, &corrupt_path)
                        .map_err(|e| format!("Failed to move corrupt workspace database: {}", e))?;
                    let wal_path = workspaces_dir.join(format!("ws_{}.db-wal", workspace_id));
                    if wal_path.exists() {
                        let _ =
                            std::fs::rename(&wal_path, format!("{}.wal", corrupt_path.display()));
                    }
                    let shm_path = workspaces_dir.join(format!("ws_{}.db-shm", workspace_id));
                    if shm_path.exists() {
                        let _ =
                            std::fs::rename(&shm_path, format!("{}.shm", corrupt_path.display()));
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[WorkspaceDatabase] Failed to run integrity_check, attempting recovery: {}",
                        e
                    );
                }
                _ => {}
            }
        }

        let manager = SqliteConnectionManager::file(&db_path).with_init(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
            )?;
            Ok(())
        });
        // 🔧 P39 优化：扩大连接池以支持多子代理并行执行
        // 原 max_size=4，改为 8 以支持更多并发数据库操作
        let pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .map_err(|e| format!("Failed to create connection pool: {}", e))?;

        let conn = pool
            .get()
            .map_err(|e| format!("Failed to get connection: {}", e))?;
        conn.execute_batch(WORKSPACE_SCHEMA)
            .map_err(|e| format!("Failed to create schema: {}", e))?;
        migrate_schema(&conn)?;

        Ok(Self {
            workspace_id: workspace_id.to_string(),
            db_path,
            pool: std::sync::RwLock::new(pool),
            maintenance_mode: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn get_connection(&self) -> Result<WorkspacePooledConnection, String> {
        if self
            .maintenance_mode
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(
                "Workspace database is in maintenance mode (backup/restore in progress)"
                    .to_string(),
            );
        }
        let pool = self
            .pool
            .read()
            .map_err(|e| format!("Pool lock poisoned: {}", e))?;
        pool.get()
            .map_err(|e| format!("Failed to get connection: {}", e))
    }

    pub fn enter_maintenance_mode(&self) -> Result<(), String> {
        if let Ok(conn) = self.get_connection() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }

        self.maintenance_mode
            .store(true, std::sync::atomic::Ordering::Release);

        let mem_manager = SqliteConnectionManager::memory();
        let mem_pool = Pool::builder()
            .max_size(1)
            .build(mem_manager)
            .map_err(|e| {
                self.maintenance_mode
                    .store(false, std::sync::atomic::Ordering::Release);
                format!("创建内存连接池失败: {}", e)
            })?;

        let mut guard = self.pool.write().map_err(|e| {
            self.maintenance_mode
                .store(false, std::sync::atomic::Ordering::Release);
            format!("Pool lock poisoned: {}", e)
        })?;
        *guard = mem_pool;

        log::info!("[WorkspaceDatabase:{}] 已进入维护模式", self.workspace_id);
        Ok(())
    }

    pub fn exit_maintenance_mode(&self) -> Result<(), String> {
        let manager = SqliteConnectionManager::file(&self.db_path).with_init(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
            )?;
            Ok(())
        });
        let new_pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .map_err(|e| format!("重建工作区连接池失败: {}", e))?;

        {
            let mut guard = self
                .pool
                .write()
                .map_err(|e| format!("Pool lock poisoned: {}", e))?;
            *guard = new_pool;
        }

        self.maintenance_mode
            .store(false, std::sync::atomic::Ordering::Release);

        log::info!("[WorkspaceDatabase:{}] 已退出维护模式", self.workspace_id);
        Ok(())
    }

    pub fn delete_database(workspaces_dir: &Path, workspace_id: &str) -> Result<(), String> {
        validate_workspace_id(workspace_id)?;
        let db_path = workspaces_dir.join(format!("ws_{}.db", workspace_id));
        let deleted_size = std::fs::metadata(&db_path).ok().map(|m| m.len());
        if db_path.exists() {
            std::fs::remove_file(&db_path)
                .map_err(|e| format!("Failed to delete workspace database: {}", e))?;
        }
        let wal_path = workspaces_dir.join(format!("ws_{}.db-wal", workspace_id));
        if wal_path.exists() {
            let _ = std::fs::remove_file(&wal_path);
        }
        let shm_path = workspaces_dir.join(format!("ws_{}.db-shm", workspace_id));
        if shm_path.exists() {
            let _ = std::fs::remove_file(&shm_path);
        }
        Self::enqueue_workspace_deletion_best_effort(workspaces_dir, workspace_id, deleted_size);
        Ok(())
    }

    fn enqueue_workspace_deletion_best_effort(
        workspaces_dir: &Path,
        workspace_id: &str,
        size: Option<u64>,
    ) {
        let Some(active_dir) = workspaces_dir.parent() else {
            return;
        };
        let chat_db = active_dir.join("chat_v2.db");
        if !chat_db.exists() {
            return;
        }

        match Connection::open(&chat_db) {
            Ok(conn) => {
                let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
                if let Err(err) =
                    crate::data_governance::file_deletion_queue::enqueue_workspace_deletion(
                        &conn,
                        workspace_id,
                        size,
                    )
                {
                    log::warn!(
                        "[WorkspaceDatabase] 写入工作区删除队列失败（不阻塞删除）: workspace_id={}, err={}",
                        workspace_id,
                        err
                    );
                }
            }
            Err(err) => {
                log::warn!(
                    "[WorkspaceDatabase] 打开 chat_v2.db 写工作区删除队列失败（不阻塞删除）: {}",
                    err
                );
            }
        }
    }
}

use std::collections::HashMap;
use std::sync::RwLock;

pub struct WorkspaceDatabaseManager {
    workspaces_dir: PathBuf,
    databases: RwLock<HashMap<WorkspaceId, Arc<WorkspaceDatabase>>>,
}

impl WorkspaceDatabaseManager {
    pub fn new(workspaces_dir: PathBuf) -> Self {
        Self {
            workspaces_dir,
            databases: RwLock::new(HashMap::new()),
        }
    }

    pub fn get_or_create(&self, workspace_id: &str) -> Result<Arc<WorkspaceDatabase>, String> {
        {
            let databases = self.databases.read().unwrap_or_else(|poisoned| {
                log::error!(
                    "[WorkspaceDatabaseManager] RwLock poisoned (read)! Attempting recovery"
                );
                poisoned.into_inner()
            });
            if let Some(db) = databases.get(workspace_id) {
                return Ok(Arc::clone(db));
            }
        }

        let mut databases = self.databases.write().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceDatabaseManager] RwLock poisoned (write)! Attempting recovery");
            poisoned.into_inner()
        });
        if let Some(db) = databases.get(workspace_id) {
            return Ok(Arc::clone(db));
        }

        let db = WorkspaceDatabase::new(&self.workspaces_dir, workspace_id)?;
        let db = Arc::new(db);
        databases.insert(workspace_id.to_string(), Arc::clone(&db));
        Ok(db)
    }

    pub fn remove(&self, workspace_id: &str) -> Option<Arc<WorkspaceDatabase>> {
        let mut databases = self.databases.write().unwrap_or_else(|poisoned| {
            log::error!("[WorkspaceDatabaseManager] RwLock poisoned (write)! Attempting recovery");
            poisoned.into_inner()
        });
        databases.remove(workspace_id)
    }

    pub fn delete(&self, workspace_id: &str) -> Result<(), String> {
        self.remove(workspace_id);
        WorkspaceDatabase::delete_database(&self.workspaces_dir, workspace_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_workspace_id_accepts_generated_ids() {
        let id = super::super::types::Workspace::generate_id();
        assert!(validate_workspace_id(&id).is_ok(), "generated id {}", id);
        assert!(validate_workspace_id("ws_01ARZ3NDEKTSV4RRFFQ69G5FAV").is_ok());
        assert!(validate_workspace_id("legacy-id_123").is_ok());
    }

    #[test]
    fn validate_workspace_id_rejects_path_escapes() {
        for bad in [
            "",
            "..",
            "../evil",
            "a/b",
            "a\\b",
            "ws_..",
            "ws_1\0",
            "ws 1",
            "ws_1.db",
        ] {
            assert!(
                validate_workspace_id(bad).is_err(),
                "should reject {:?}",
                bad
            );
        }
        let too_long = "a".repeat(129);
        assert!(validate_workspace_id(&too_long).is_err());
    }

    #[test]
    fn workspace_database_new_rejects_traversal_ids() {
        let temp = TempDir::new().unwrap();
        assert!(WorkspaceDatabase::new(temp.path(), "../escape").is_err());
        assert!(WorkspaceDatabase::delete_database(temp.path(), "../escape").is_err());
        // 合法 id 正常创建
        let db = WorkspaceDatabase::new(temp.path(), "ws_testvalid123").unwrap();
        assert!(db.db_path().exists());
    }
}
