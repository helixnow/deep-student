-- ============================================================================
-- V20260728: todo_items 提醒轮询索引 + 清单内排序复合索引
-- ============================================================================
--
-- 1. idx_todo_items_reminder
--    前端提醒调度器周期性调用 todo_list_reminders：
--      WHERE reminder IS NOT NULL AND reminder != '' AND status = 'pending'
--        AND deleted_at IS NULL ORDER BY reminder ASC
--    此前无 reminder 索引，每次轮询全表扫描。部分索引只覆盖设置了提醒的
--    未删除行（体量远小于全表），且索引序即 ORDER BY reminder 序。
--    （reminder != '' 与 status 由查询在索引扫描结果上继续过滤。）
--
-- 2. idx_todo_items_list_parent_sort
--    清单视图 list_items_by_list 按 (todo_list_id) 过滤后按 sort_order 排序；
--    每次创建条目 / 跨清单移动 / 重复任务派生都要做
--      SELECT MAX(sort_order) ... WHERE todo_list_id = ? AND parent_id IS ? AND deleted_at IS NULL
--    复合部分索引同时服务两者（前缀匹配 + MAX 走索引末端）。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_todo_items_reminder
ON todo_items(reminder)
WHERE reminder IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_todo_items_list_parent_sort
ON todo_items(todo_list_id, parent_id, sort_order)
WHERE deleted_at IS NULL;
