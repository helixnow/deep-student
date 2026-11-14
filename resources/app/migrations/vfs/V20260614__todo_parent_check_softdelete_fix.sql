-- ============================================================================
-- V20260614: 修复 parent_id 同清单校验与软删除的冲突
-- ============================================================================
--
-- V20260311 的两个触发器在校验 parent 时带了 deleted_at IS NULL 过滤：
--   (SELECT todo_list_id FROM todo_items
--     WHERE id = NEW.parent_id AND deleted_at IS NULL) IS NOT NEW.todo_list_id
--
-- 后果：软删除父任务后，对其子任务的任何 UPDATE（包括子树级联软删除本身、
-- 回收站恢复批次标记等）都会因父任务"查不到"而 ABORT——删除带子任务的
-- 父任务必然失败。
--
-- 修复语义：
-- - INSERT：parent 行必须存在（防悬挂引用，云同步隔离区依赖此行为）
--   且属于同一清单；是否软删除不影响（同批次恢复/重复任务生成场景）。
-- - UPDATE：仅当 parent 行仍物理存在时校验同清单；行已被彻底删除的
--   悬挂引用不阻塞本行更新（否则该行永远无法修改）。
-- ============================================================================

DROP TRIGGER IF EXISTS trg_todo_items_validate_insert;

CREATE TRIGGER trg_todo_items_validate_insert
BEFORE INSERT ON todo_items
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
      AND (
        SELECT todo_list_id
        FROM todo_items
        WHERE id = NEW.parent_id
      ) IS NOT NEW.todo_list_id;
END;

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
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM todo_items WHERE parent_id = NEW.id AND deleted_at IS NULL
          UNION ALL
          SELECT ti.id
          FROM todo_items ti
          JOIN descendants d ON ti.parent_id = d.id
          WHERE ti.deleted_at IS NULL
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
      );
END;
