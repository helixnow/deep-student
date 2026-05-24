-- Compaction (P1): anchored summary + tail preservation for long chats.
-- Mirrors opencode's CompactionPart semantics but persisted as a first-class record.
-- One active compaction per session at a time (latest by created_at wins).

CREATE TABLE IF NOT EXISTS chat_v2_compactions (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL,
    -- The summary assistant message (compaction block lives under this message id).
    summary_message_id      TEXT NOT NULL,
    -- First preserved (verbatim) message id; anything with time_created < this cutoff
    -- is hidden from the LLM view. Original rows stay in DB for "expand original".
    tail_start_message_id   TEXT NOT NULL,
    tail_start_time_created INTEGER NOT NULL,
    reason                  TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual' | 'overflow'
    is_auto                 INTEGER NOT NULL DEFAULT 1,
    is_overflow             INTEGER NOT NULL DEFAULT 0,
    tokens_before           INTEGER,
    tokens_after            INTEGER,
    model_id                TEXT,
    created_at              INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_session_created
    ON chat_v2_compactions(session_id, created_at DESC);

-- Block-level pruning marker. When set, the block's body is skipped in LLM context
-- but still rendered in the UI (styled as pruned). Used for stale tool outputs.
ALTER TABLE chat_v2_blocks ADD COLUMN compacted_at INTEGER DEFAULT NULL;

-- Session-level cached pointer to the most recent compaction for O(1) lookup.
ALTER TABLE chat_v2_sessions ADD COLUMN last_compaction_id TEXT DEFAULT NULL;
