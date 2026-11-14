-- ============================================================================
-- V20260203: 补齐 subagent_task 表
-- ============================================================================
--
-- 目的：为旧库补齐子代理任务表与索引，避免迁移验证失败
-- 安全：使用 IF NOT EXISTS，幂等可重复执行
-- ============================================================================

CREATE TABLE IF NOT EXISTS subagent_task (
    id TEXT PRIMARY KEY,                               -- 任务 ID
    workspace_id TEXT NOT NULL,                        -- 工作区 ID
    agent_session_id TEXT NOT NULL,                    -- 代理会话 ID
    skill_id TEXT,                                     -- Skill ID
    status TEXT NOT NULL DEFAULT 'pending',            -- 任务状态：pending, running, completed, failed
    task_content TEXT,                                 -- 原始任务内容
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),  -- 最后活跃时间
    needs_recovery INTEGER NOT NULL DEFAULT 0,         -- 是否需要恢复
    created_at TEXT NOT NULL DEFAULT (datetime('now')),-- 创建时间
    FOREIGN KEY (workspace_id) REFERENCES workspace_index(workspace_id) ON DELETE CASCADE
);

-- STEP 1: 数据完整性修复（外键约束）
-- 若历史数据存在 workspace_id 指向不存在的 workspace_index，将导致外键约束失败；
-- 此处先清理潜在的孤儿数据，确保迁移检查器与实际约束均可通过。
DELETE FROM subagent_task
WHERE workspace_id NOT IN (SELECT workspace_id FROM workspace_index);

CREATE INDEX IF NOT EXISTS idx_subagent_task_status ON subagent_task(status);
CREATE INDEX IF NOT EXISTS idx_subagent_task_recovery ON subagent_task(needs_recovery) WHERE needs_recovery = 1;
