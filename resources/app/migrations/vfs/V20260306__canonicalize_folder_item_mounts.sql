-- 统一历史 folder_items/file path_cache 中的 textbook 别名为 file
UPDATE folder_items
SET item_type = 'file'
WHERE item_type = 'textbook';

DELETE FROM path_cache
WHERE item_type = 'textbook'
  AND EXISTS (
      SELECT 1
      FROM path_cache AS canonical
      WHERE canonical.item_type = 'file'
        AND canonical.item_id = path_cache.item_id
  );

UPDATE path_cache
SET item_type = 'file'
WHERE item_type = 'textbook';

-- 清理历史“同一资源多个活动挂载”异常，保留最新的一条活动记录
UPDATE folder_items
SET
    deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE deleted_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM folder_items AS better
      WHERE better.deleted_at IS NULL
        AND better.item_id = folder_items.item_id
        AND (
          COALESCE(better.updated_at, better.created_at) > COALESCE(folder_items.updated_at, folder_items.created_at)
          OR (
            COALESCE(better.updated_at, better.created_at) = COALESCE(folder_items.updated_at, folder_items.created_at)
            AND better.created_at > folder_items.created_at
          )
          OR (
            COALESCE(better.updated_at, better.created_at) = COALESCE(folder_items.updated_at, folder_items.created_at)
            AND better.created_at = folder_items.created_at
            AND better.id > folder_items.id
          )
        )
  );

-- 约束：同一资源在活动态只能有一个挂载位置
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_items_item_active_unique
    ON folder_items(item_id)
    WHERE deleted_at IS NULL;
