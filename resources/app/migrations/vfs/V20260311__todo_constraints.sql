-- ============================================================================
-- Todo constraints and validation triggers (V20260311__todo_constraints.sql)
-- ============================================================================
--
-- Strengthens todo domain integrity for existing databases without rebuilding
-- tables. We enforce:
-- 1. status / priority enum-like values
-- 2. parent item must exist in the same list
-- 3. parent_id cannot point to self or create a cycle
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_todo_items_validate_insert
BEFORE INSERT ON todo_items
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'todo_items.status is invalid')
    WHERE NEW.status NOT IN ('pending', 'completed', 'cancelled');

    SELECT RAISE(ABORT, 'todo_items.priority is invalid')
    WHERE NEW.priority NOT IN ('none', 'low', 'medium', 'high', 'urgent');

    SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
    WHERE NEW.parent_id IS NOT NULL
      AND (
        SELECT todo_list_id
        FROM todo_items
        WHERE id = NEW.parent_id AND deleted_at IS NULL
      ) IS NOT NEW.todo_list_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_todo_items_validate_update
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
      AND (
        SELECT todo_list_id
        FROM todo_items
        WHERE id = NEW.parent_id AND deleted_at IS NULL
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
