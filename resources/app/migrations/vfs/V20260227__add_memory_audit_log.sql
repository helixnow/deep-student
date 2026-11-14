-- ============================================================================
-- 记忆操作审计日志表 (V20260227__add_memory_audit_log.sql)
-- ============================================================================
--
-- 记录所有对记忆系统的操作，包括成功和失败，用于调试和优化记忆系统。
--
-- 来源 (source):
--   tool_call      — LLM 通过工具调用写入
--   auto_extract   — 后台自动提取 pipeline
--   handler        — 前端 handler / Tauri 命令
--   evolution      — 自进化系统
--   manual         — 手动操作
--
-- 操作 (operation):
--   write / write_smart / update / delete / search / extract / profile_refresh
--   category_refresh / evolution_cycle
-- ============================================================================

CREATE TABLE IF NOT EXISTS memory_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    source TEXT NOT NULL,           -- tool_call | auto_extract | handler | evolution | manual
    operation TEXT NOT NULL,        -- write | write_smart | update | delete | search | extract ...
    success INTEGER NOT NULL DEFAULT 1,  -- 1=成功 0=失败
    note_id TEXT,                   -- 操作涉及的笔记 ID（可为空）
    title TEXT,                     -- 记忆标题
    content_preview TEXT,           -- 内容预览（截断至 100 字）
    folder TEXT,                    -- 文件夹路径
    event TEXT,                     -- write_smart 的决策事件：ADD/UPDATE/APPEND/DELETE/NONE
    confidence REAL,                -- write_smart 的置信度
    reason TEXT,                    -- 决策原因 / 错误信息
    session_id TEXT,                -- 触发操作的会话 ID（可为空）
    duration_ms INTEGER,            -- 操作耗时（毫秒）
    extra_json TEXT                 -- 扩展字段（JSON），存储不常用的详细信息
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_log_timestamp ON memory_audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_memory_audit_log_source ON memory_audit_log(source);
CREATE INDEX IF NOT EXISTS idx_memory_audit_log_operation ON memory_audit_log(operation);
CREATE INDEX IF NOT EXISTS idx_memory_audit_log_note_id ON memory_audit_log(note_id);
