-- ============================================================================
-- V20260615: todo_items 环检测覆盖软删除节点（全图遍历 + 深度上限）
-- ============================================================================
--
-- V20260614 的 UPDATE 触发器环检测只沿 deleted_at IS NULL 的子链遍历，
-- 含软删除节点的环不会被发现。跨设备同步可以合并出这种潜伏环：
--   设备1：A.parent = B，随后软删除 A；
--   设备2：B.parent = A（当时 A 在该设备上未删除）。
-- 合并后 A(已删, parent=B) 与 B(存活, parent=A) 互指。此时：
-- - 恢复 A 的批次会触发"would create a cycle"中止，回收站条目永远无法恢复；
-- - 若两节点同批恢复，恢复语句中途 ABORT，整批回滚。
--
-- 修复：环是图的结构属性，与删除状态无关——遍历全部节点。
-- 同时给递归加深度上限（100 层），防止历史坏数据中已存在的环
-- 让触发器内的递归 CTE（UNION ALL 无去重）无限循环。
--
-- INSERT 不可能成环（新行 id 无人引用），INSERT 触发器无需环检测。
-- ============================================================================

DROP TRIGGER IF EXISTS trg_todo_items_validate_update;

CREATE TRIGGER trg_todo_items_validate_update
BEFORE UPDATE ON todo_items
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'todo_items.status is invalid')
    WHERE NEW.status NOT IN ('pending', 'completed', 'cancelled');

    SELECT RAISE(ABORT, 'todo_items.priority is invalid')
    WHERE NEW.priority NOT IN ('none', 'low', 'medium', 'high', 'urgent');

    SELECT RAISE(ABORT, 'todo_items.parent_id cannot reference self')
    WHERE NEW.parent_id = NEW.id;

    SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
    WHERE NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM todo_items WHERE id = NEW.parent_id)
      AND (
        SELECT todo_list_id
        FROM todo_items
        WHERE id = NEW.parent_id
      ) IS NOT NEW.todo_list_id;

    SELECT RAISE(ABORT, 'todo_items.parent_id would create a cycle')
    WHERE NEW.parent_id IS NOT NULL
      AND EXISTS (
        WITH RECURSIVE descendants(id, depth) AS (
          SELECT id, 1 FROM todo_items WHERE parent_id = NEW.id
          UNION ALL
          SELECT ti.id, d.depth + 1
          FROM todo_items ti
          JOIN descendants d ON ti.parent_id = d.id
          WHERE d.depth < 100
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
      );
END;
