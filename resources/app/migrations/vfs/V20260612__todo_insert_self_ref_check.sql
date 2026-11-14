-- ============================================================================
-- V20260612: todo_items INSERT 触发器补自引用检查（审阅问题 C3）
-- ============================================================================
--
-- V20260311 的 UPDATE 触发器有 parent_id = NEW.id 自引用检查，
-- 但 INSERT 触发器漏掉了——客户端自定 id 插入时可创建 parent_id 指向
-- 自身的节点，形成自指环，递归查询（子树展开/环检测）会出现异常行为。
--
-- 重建 INSERT 触发器，补齐自引用检查。
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
        WHERE id = NEW.parent_id AND deleted_at IS NULL
      ) IS NOT NEW.todo_list_id;
END;
