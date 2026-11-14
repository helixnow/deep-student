-- Seed l16-pending-memory-w0 (pending owner X3: seed directory mechanism).
-- Apply to mistakes.db of a data directory that the app has already started once, app stopped.
-- Current Rust never creates pending_memory_candidates: the CREATE was in
-- src-tauri/src/database/manager.rs:698-716 at 1813b3c9c (v0.9.2) and was removed in c006f457b
-- (2026-07-20) without a DROP. Data directories first created by v0.9.2 still carry the table;
-- empty-seed databases do not (every command there fails with "no such table").
-- The DDL below is that v0.9.2 text verbatim. Rows only come from the knowledge_extract LLM tool
-- (src-tauri/src/chat_v2/tools/knowledge_executor.rs:113-140), not from any frontend command.
CREATE TABLE IF NOT EXISTS pending_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    origin TEXT DEFAULT 'auto_extract',
    user_edited INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'saved', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'))
);
CREATE INDEX IF NOT EXISTS idx_pending_mem_conversation ON pending_memory_candidates(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pending_mem_status ON pending_memory_candidates(status);
CREATE INDEX IF NOT EXISTS idx_pending_mem_expires ON pending_memory_candidates(expires_at);

-- Explicit timestamps so A and B start from identical bytes. Row 6 is already expired:
-- dismiss/mark do not filter on expires_at (only get_pending_memory_candidates deletes expired rows).
INSERT INTO pending_memory_candidates (id, conversation_id, content, category, origin, user_edited, status, created_at, expires_at) VALUES
(1, 'w233-conv-a', '偏好用中文回答', 'preference', 'tool_extract', 0, 'pending', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
(2, 'w233-conv-a', '正在备考线性代数', 'fact', 'tool_extract', 1, 'pending', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'),
(3, 'w233-conv-a', '已保存过的候选', 'fact', 'tool_extract', 0, 'saved', '2026-01-01T00:00:02.000Z', '2099-01-01T00:00:00.000Z'),
(4, 'w233-conv-a', '已忽略过的候选', 'fact', 'auto_extract', 0, 'dismissed', '2026-01-01T00:00:03.000Z', '2099-01-01T00:00:00.000Z'),
(5, 'w233-conv-b', '每天晚上复习', 'habit', 'tool_extract', 0, 'pending', '2026-01-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
(6, 'w233-conv-b', '已过期但仍 pending', 'habit', 'tool_extract', 0, 'pending', '2020-01-01T00:00:00.000Z', '2020-01-08T00:00:00.000Z'),
(7, 'w233-conv-c', '喜欢图解', 'preference', 'tool_extract', 0, 'pending', '2026-01-03T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
(8, 'chat-w233-conv-d', '库内 id 本身带 chat- 前缀', 'fact', 'tool_extract', 0, 'pending', '2026-01-04T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
(9, 'Chat-w233-conv-e', '大写前缀不会被剥离', 'fact', 'tool_extract', 0, 'pending', '2026-01-05T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
(10, '', '空 conversation_id 行', 'fact', 'tool_extract', 0, 'pending', '2026-01-06T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
