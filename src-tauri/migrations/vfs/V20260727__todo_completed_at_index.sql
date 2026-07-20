-- ============================================================================
-- V20260723: todo_items.completed_at 部分索引（今日完成统计）
-- ============================================================================
--
-- "今日已完成"统计（get_active_todo_summary.today_completed）此前用
-- `completed_at LIKE '{本地日期}%'` 匹配 UTC ISO 字符串——非 UTC 时区在
-- 日界附近（如 UTC+8 的本地 00:00-08:00 完成的任务）统计错误。
-- 代码侧已改为把本地日历日界换算成 UTC 时刻串做范围比较：
--   completed_at >= {本地今天 00:00 的 UTC} AND completed_at < {本地明天 00:00 的 UTC}
--
-- todo_items 此前没有 completed_at 索引（LIKE 前缀匹配走的是全表扫描，
-- 范围比较同样没有索引可用）。补一个与查询谓词对齐的部分索引：
-- - deleted_at IS NULL 与查询谓词一致；
-- - completed_at IS NOT NULL 由范围比较（>= / <）蕴含，SQLite 可选用该部分索引；
-- - 只索引已完成的行，索引体积随历史完成量线性、远小于全表索引。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_todo_items_completed_at
ON todo_items(completed_at)
WHERE deleted_at IS NULL AND completed_at IS NOT NULL;
