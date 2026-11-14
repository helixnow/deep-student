// workspace/database.rs 的 schema 与迁移（SQL 只允许出现在 repository/）。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** workspace/database.rs:495–498: connection-local setup, before journal operations. */
export function configureDeletionJournal(db: SqlExecutor): void {
  db.exec('PRAGMA busy_timeout = 5000');
}

export function enableDeletionJournalForeignKeys(db: SqlExecutor): void {
  db.exec('PRAGMA foreign_keys = ON');
}

export const WORKSPACE_SCHEMA = `
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
`;

export const CURRENT_SCHEMA_VERSION = 2;

export function applyWorkspaceSchema(db: SqlExecutor): void {
  try {
    db.exec(WORKSPACE_SCHEMA);
  } catch (error) {
    throw new Error(`Failed to create schema: ${errorMessage(error)}`);
  }
}

export function readUserVersion(db: SqlExecutor): number {
  try {
    const value = db.pluck<number>('PRAGMA user_version');
    return value === undefined ? 0 : Number(value);
  } catch (error) {
    throw new Error(`Failed to read user_version: ${errorMessage(error)}`);
  }
}

export function writeUserVersion(db: SqlExecutor, version: number): void {
  try {
    db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  } catch (error) {
    throw new Error(`Failed to update user_version: ${errorMessage(error)}`);
  }
}

/** `PRAGMA quick_check`：损坏时返回非 `ok` 的描述。 */
export function quickCheck(db: SqlExecutor): string {
  const value = db.pluck<string>('PRAGMA quick_check');
  return typeof value === 'string' ? value : String(value ?? '');
}

export function checkpointTruncate(db: SqlExecutor): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

function addSubagentTaskColumn(db: SqlExecutor, column: string): void {
  try {
    db.run(`ALTER TABLE subagent_task ADD COLUMN ${column} TEXT`);
    // boundary-allow empty-catch: Rust 迁移忽略重复列 ALTER 失败（列已存在的旧库）
  } catch (error) {
    // Rust 迁移同样忽略 ALTER 失败（列已存在的旧库）。
    void error;
  }
}

function subagentTaskHasColumn(db: SqlExecutor, name: string): boolean {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.all('PRAGMA table_info(subagent_task)');
  } catch {
    return false;
  }
  return rows.some(row => row['name'] === name);
}

/** `migrate_schema`：V1 = 初始建表（已由 WORKSPACE_SCHEMA 完成），V2 = 对齐 subagent_task。 */
export function migrateWorkspaceSchema(db: SqlExecutor): void {
  const currentVersion = readUserVersion(db);

  if (currentVersion < 2) {
    addSubagentTaskColumn(db, 'initial_task');
    addSubagentTaskColumn(db, 'started_at');
    addSubagentTaskColumn(db, 'completed_at');
    addSubagentTaskColumn(db, 'result_summary');
    if (subagentTaskHasColumn(db, 'task_content')) {
      try {
        db.run('UPDATE subagent_task SET initial_task = task_content WHERE initial_task IS NULL');
      } catch (error) {
        throw new Error(`Migration V2 failed while backfilling initial_task: ${errorMessage(error)}`);
      }
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_subagent_task_workspace ON subagent_task(workspace_id, status)');
    } catch (error) {
      throw new Error(`Migration V2 failed while ensuring index: ${errorMessage(error)}`);
    }
  }

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    writeUserVersion(db, CURRENT_SCHEMA_VERSION);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
