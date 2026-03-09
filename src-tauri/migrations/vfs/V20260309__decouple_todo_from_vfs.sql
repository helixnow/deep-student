-- ============================================================================
-- 解耦待办列表与 VFS (V20260309__decouple_todo_from_vfs.sql)
-- ============================================================================
--
-- 将 todo_lists 表从 VFS resources 系统中解耦：
-- 1. 重建 todo_lists 表，移除 resource_id 列和对 resources 表的 FK 约束
-- 2. 清理 folder_items 中 item_type='todo' 的记录
-- 3. 清理 resources 表中被 todo 引用的孤立记录
--
-- SQLite 不支持 ALTER TABLE DROP COLUMN (with FK)，使用 rename+recreate 模式。
-- 生成时间：2026-03-09
-- ============================================================================

-- ============================================================================
-- 1. 重建 todo_lists 表（移除 resource_id 列）
-- ============================================================================

-- 1a. 创建新表（无 resource_id）
CREATE TABLE IF NOT EXISTS todo_lists_new (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

-- 1b. 迁移数据
INSERT INTO todo_lists_new (id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at)
SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
FROM todo_lists;

-- 1c. 删除旧表
DROP TABLE IF EXISTS todo_lists;

-- 1d. 重命名新表
ALTER TABLE todo_lists_new RENAME TO todo_lists;

-- 1e. 重建索引
CREATE INDEX IF NOT EXISTS idx_todo_lists_deleted ON todo_lists(deleted_at);
CREATE INDEX IF NOT EXISTS idx_todo_lists_favorite ON todo_lists(is_favorite);
CREATE INDEX IF NOT EXISTS idx_todo_lists_updated ON todo_lists(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_lists_default ON todo_lists(is_default) WHERE is_default = 1;

-- ============================================================================
-- 2. 清理 folder_items 中的 todo 记录
-- ============================================================================
DELETE FROM folder_items WHERE item_type = 'todo';

-- ============================================================================
-- 3. 清理 resources 表中被 todo 引用的孤立记录
--    source_table = 'todo_lists' 的 resources 记录不再需要
-- ============================================================================
DELETE FROM resources WHERE source_table = 'todo_lists';
