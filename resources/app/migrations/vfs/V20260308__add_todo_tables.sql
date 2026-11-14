-- ============================================================================
-- 待办列表 + 待办项表 (V20260308__add_todo_tables.sql)
-- ============================================================================
--
-- 新增用户面向的待办管理系统，与现有 Agent todo-tools 完全独立。
-- - todo_lists: 待办列表元数据（类比 mindmaps 表）
-- - todo_items: 待办项（子任务通过 parent_id 自引用）
--
-- 生成时间：2026-03-08
-- ============================================================================

-- ============================================================================
-- 1. 待办列表元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS todo_lists (
    id TEXT PRIMARY KEY NOT NULL,               -- 格式: tdl_{nanoid(10)}
    resource_id TEXT NOT NULL,                  -- 内容存 resources（JSON 摘要）
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,      -- 是否为默认收件箱
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,                   -- ISO 8601
    updated_at TEXT NOT NULL,                   -- ISO 8601
    deleted_at TEXT,                            -- 软删除
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_todo_lists_deleted ON todo_lists(deleted_at);
CREATE INDEX IF NOT EXISTS idx_todo_lists_favorite ON todo_lists(is_favorite);
CREATE INDEX IF NOT EXISTS idx_todo_lists_resource ON todo_lists(resource_id);
CREATE INDEX IF NOT EXISTS idx_todo_lists_updated ON todo_lists(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_lists_default ON todo_lists(is_default) WHERE is_default = 1;

-- ============================================================================
-- 2. 待办项表
-- ============================================================================
CREATE TABLE IF NOT EXISTS todo_items (
    id TEXT PRIMARY KEY NOT NULL,               -- 格式: ti_{nanoid(10)}
    todo_list_id TEXT NOT NULL,                 -- 所属列表
    title TEXT NOT NULL,
    description TEXT,                           -- Markdown 描述
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | completed | cancelled
    priority TEXT NOT NULL DEFAULT 'none',      -- none | low | medium | high | urgent
    due_date TEXT,                              -- ISO 8601 日期 (YYYY-MM-DD)
    due_time TEXT,                              -- HH:mm
    reminder TEXT,                              -- ISO 8601 提醒时间
    tags_json TEXT NOT NULL DEFAULT '[]',       -- JSON 数组
    sort_order INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,                             -- 父任务 ID（子任务）
    completed_at TEXT,                          -- 完成时间 ISO 8601
    repeat_json TEXT,                           -- 重复配置 JSON
    attachments_json TEXT NOT NULL DEFAULT '[]', -- 关联 DSTU 资源 ID JSON 数组
    created_at TEXT NOT NULL,                   -- ISO 8601
    updated_at TEXT NOT NULL,                   -- ISO 8601
    deleted_at TEXT,                            -- 软删除
    FOREIGN KEY (todo_list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES todo_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_todo_items_list ON todo_items(todo_list_id);
CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status);
CREATE INDEX IF NOT EXISTS idx_todo_items_priority ON todo_items(priority);
CREATE INDEX IF NOT EXISTS idx_todo_items_due_date ON todo_items(due_date);
CREATE INDEX IF NOT EXISTS idx_todo_items_parent ON todo_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_todo_items_deleted ON todo_items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_todo_items_updated ON todo_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_items_list_status ON todo_items(todo_list_id, status) WHERE deleted_at IS NULL;
