-- 修复历史异常：同一 note 在多个 folder 下同时处于活动态会放大 memory list/merge
UPDATE folder_items
SET
    deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE item_type = 'note'
  AND deleted_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM folder_items AS better
      WHERE better.item_type = 'note'
        AND better.deleted_at IS NULL
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

-- 仅允许 note 在活动态拥有唯一挂载位置（软删记录仍可保留）
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_items_note_active_unique
    ON folder_items(item_type, item_id)
    WHERE item_type = 'note' AND deleted_at IS NULL;

-- 覆盖 note 列表查询的常用过滤与排序
CREATE INDEX IF NOT EXISTS idx_folder_items_note_folder_sort_active
    ON folder_items(folder_id, sort_order, item_id)
    WHERE item_type = 'note' AND deleted_at IS NULL;

-- 覆盖 note 生命周期（恢复/软删）更新路径
CREATE INDEX IF NOT EXISTS idx_folder_items_note_lifecycle
    ON folder_items(item_type, item_id, deleted_at)
    WHERE item_type = 'note';

-- 提升审计日志过滤 + 时间倒序读取性能
CREATE INDEX IF NOT EXISTS idx_memory_audit_log_source_operation_success_id_desc
    ON memory_audit_log(source, operation, success, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_audit_log_operation_id_desc
    ON memory_audit_log(operation, id DESC);
