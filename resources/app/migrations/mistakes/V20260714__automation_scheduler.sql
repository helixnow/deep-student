-- ============================================================================
-- V20260714: Durable automation scheduler state and run history
-- ============================================================================

CREATE TABLE IF NOT EXISTS automation_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source_session_id TEXT NOT NULL DEFAULT '',
    last_run_at TEXT,
    next_run_at TEXT,
    action_type TEXT NOT NULL DEFAULT 'notify'
        CHECK (action_type IN ('notify', 'agent_turn')),
    heartbeat INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat IN (0, 1)),
    agent_prompt TEXT,
    session_mode TEXT CHECK (session_mode IS NULL OR session_mode IN ('isolated', 'named')),
    model_id TEXT,
    agent_session_id TEXT,
    catch_up_policy TEXT NOT NULL DEFAULT 'run_once'
        CHECK (catch_up_policy IN ('skip', 'run_once', 'catch_up_all')),
    max_retries INTEGER NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 10),
    retry_backoff_seconds INTEGER NOT NULL DEFAULT 60
        CHECK (retry_backoff_seconds BETWEEN 5 AND 86400),
    timeout_seconds INTEGER NOT NULL DEFAULT 600
        CHECK (timeout_seconds BETWEEN 30 AND 3600),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_automation_definitions_enabled_next
    ON automation_definitions(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_updated
    ON automation_definitions(updated_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    trigger_type TEXT NOT NULL DEFAULT 'schedule'
        CHECK (trigger_type IN ('schedule', 'manual', 'retry', 'recovery')),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued', 'running', 'retrying', 'success', 'error', 'timeout',
            'heartbeat_ok', 'spawn_error', 'cancelled', 'skipped'
        )),
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
    claimed_by TEXT,
    claimed_at TEXT,
    next_attempt_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    session_id TEXT,
    delivered_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (automation_id) REFERENCES automation_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_created
    ON automation_runs(automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_retry_due
    ON automation_runs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status_updated
    ON automation_runs(status, updated_at DESC);
