-- ============================================================================
-- V20260801: 待办/番茄钟统计与批量操作的查询索引
-- ============================================================================
--
-- 配套 2026-07-20 的番茄钟+待办后端改造（批量操作 / 统计聚合命令），
-- 补齐三条高频查询路径的索引。全部为只增索引，幂等、向前兼容。
--
-- 1. idx_todo_items_status_due
--    today/overdue/upcoming 视图与 counts_snapshot / stats_overview 的
--    高频谓词是 `status = 'pending' AND due_date <cmp> ?`。现有
--    idx_todo_items_due_date 是全表单列索引（含软删行、无 status 前缀），
--    命中后仍需回表过滤 status/deleted_at。复合部分索引与谓词精确对齐：
--    status 等值前缀 + due_date 范围列，deleted_at IS NULL 与查询一致。
--
-- 2. idx_pomodoro_records_work_created
--    番茄钟统计路径（today_stats / daily_stats / hourly_stats /
--    stats_by_todo / stats_overview）的统一谓词是
--    `type = 'work' AND created_at >= ? AND deleted_at IS NULL`。
--    现有 idx_pomodoro_created 为全表索引（含 break/软删行）。
--    部分索引只覆盖未删 work 行，等值 type 已由 WHERE 蕴含，
--    索引列 created_at 直接服务范围扫描。
--
-- 3. idx_pomodoro_records_item_created
--    任务关联查询（list_by_todo_item / todo_focus_summary）按
--    `todo_item_id = ? AND deleted_at IS NULL` 过滤并按 created_at 排序。
--    现有 idx_pomodoro_item 为单列全表索引；复合部分索引使
--    过滤 + 排序一次索引扫描完成。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_todo_items_status_due
ON todo_items(status, due_date)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pomodoro_records_work_created
ON pomodoro_records(created_at)
WHERE type = 'work' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pomodoro_records_item_created
ON pomodoro_records(todo_item_id, created_at)
WHERE todo_item_id IS NOT NULL AND deleted_at IS NULL;
