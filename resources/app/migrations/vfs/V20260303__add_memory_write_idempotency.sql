-- 记录 memory_write_smart 的幂等结果，避免超时重试导致重复写入
CREATE TABLE IF NOT EXISTS memory_write_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    note_id TEXT,
    event TEXT NOT NULL,
    is_new INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1.0,
    reason TEXT NOT NULL,
    resource_id TEXT,
    downgraded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_write_idempotency_created_at
    ON memory_write_idempotency(created_at);
