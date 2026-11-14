-- ============================================================================
-- 待办番茄钟扩展 (V20260310__add_pomodoro.sql)
-- ============================================================================
--
-- 1. 为 todo_items 增加番茄钟预估与完成数字段
-- 2. 新增 pomodoro_records 表记录详细的专注历史
--
-- 生成时间：2026-03-10
-- ============================================================================

-- ============================================================================
-- 1. 扩展 todo_items 表
-- ============================================================================
ALTER TABLE todo_items ADD COLUMN estimated_pomodoros INTEGER DEFAULT 0;
ALTER TABLE todo_items ADD COLUMN completed_pomodoros INTEGER DEFAULT 0;

-- ============================================================================
-- 2. 专注记录表 pomodoro_records
-- ============================================================================
CREATE TABLE IF NOT EXISTS pomodoro_records (
    id TEXT PRIMARY KEY NOT NULL,               -- 格式: pd_{nanoid}
    todo_item_id TEXT,                          -- 关联的任务ID（可为空，代表纯番茄钟）
    start_time TEXT NOT NULL,                   -- 开始时间 ISO 8601
    end_time TEXT,                              -- 结束时间 ISO 8601
    duration INTEGER NOT NULL,                  -- 计划时长(秒，默认 25*60)
    actual_duration INTEGER NOT NULL DEFAULT 0, -- 实际专注时长(秒)
    type TEXT NOT NULL DEFAULT 'work',          -- 枚举: work | short_break | long_break
    status TEXT NOT NULL DEFAULT 'completed',   -- 枚举: completed | interrupted
    created_at TEXT NOT NULL,
    
    FOREIGN KEY (todo_item_id) REFERENCES todo_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pomodoro_item ON pomodoro_records(todo_item_id);
CREATE INDEX IF NOT EXISTS idx_pomodoro_type ON pomodoro_records(type);
CREATE INDEX IF NOT EXISTS idx_pomodoro_status ON pomodoro_records(status);
CREATE INDEX IF NOT EXISTS idx_pomodoro_created ON pomodoro_records(created_at DESC);
