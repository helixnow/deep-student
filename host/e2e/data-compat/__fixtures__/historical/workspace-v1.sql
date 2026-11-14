
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
