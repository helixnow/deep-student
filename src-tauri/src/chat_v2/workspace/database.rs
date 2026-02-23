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

const CURRENT_SCHEMA_VERSION: i32 = 1;

fn migrate_schema(conn: &Connection) -> Result<(), String> {
    let current_version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read user_version: {}", e))?;

    if current_version < 1 {
        // V1: initial schema — tables already created via WORKSPACE_SCHEMA above.
        // Future migrations go here as additional version checks.
    }

    // 未来新增迁移示例：
    // if current_version < 2 {
    //     conn.execute("ALTER TABLE agent ADD COLUMN priority INTEGER DEFAULT 0", [])
    //         .map_err(|e| format!("Migration V2 failed: {}", e))?;
    // }

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
        if self.maintenance_mode.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Workspace database is in maintenance mode (backup/restore in progress)".to_string());
        }
        let pool = self.pool.read().map_err(|e| format!("Pool lock poisoned: {}", e))?;
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

        log::info!(
            "[WorkspaceDatabase:{}] 已进入维护模式",
            self.workspace_id
        );
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

        log::info!(
            "[WorkspaceDatabase:{}] 已退出维护模式",
            self.workspace_id
        );
        Ok(())
    }

    pub fn delete_database(workspaces_dir: &Path, workspace_id: &str) -> Result<(), String> {
        let db_path = workspaces_dir.join(format!("ws_{}.db", workspace_id));
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
        Ok(())
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
