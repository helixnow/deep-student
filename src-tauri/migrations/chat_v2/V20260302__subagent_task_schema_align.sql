-- ============================================================================
-- V20260302: 对齐 subagent_task 结构到运行时代码约定
-- ============================================================================
--
-- 背景：历史 schema 使用 task_content/last_active_at/needs_recovery，
-- 而当前 workspace 子代理任务读写使用 initial_task/started_at/completed_at/result_summary。
-- 本迁移补齐缺失列并回填 initial_task，避免恢复链路在旧库上失败。
-- ============================================================================

ALTER TABLE subagent_task ADD COLUMN initial_task TEXT;
ALTER TABLE subagent_task ADD COLUMN started_at TEXT;
ALTER TABLE subagent_task ADD COLUMN completed_at TEXT;
ALTER TABLE subagent_task ADD COLUMN result_summary TEXT;

UPDATE subagent_task
SET initial_task = task_content
WHERE initial_task IS NULL;

CREATE INDEX IF NOT EXISTS idx_subagent_task_workspace
ON subagent_task(workspace_id, status);
