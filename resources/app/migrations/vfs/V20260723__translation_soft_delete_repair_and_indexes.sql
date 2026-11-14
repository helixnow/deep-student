-- 翻译仓库层加固（配合 translation_repo.rs 2026-07-19 修复）
--
-- 1. 数据修复：历史上 trash 入口只软删 translations 不软删 folder_items，
--    留下"翻译已进回收站但文件夹树仍挂载"的幽灵条目。此处把这类
--    folder_items 补软删，与新的级联删除语义对齐（恢复路径会同步恢复）。
UPDATE folder_items
SET
    deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE item_type = 'translation'
  AND deleted_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM translations t
      WHERE t.id = folder_items.item_id
        AND t.deleted_at IS NOT NULL
  );

-- 2. 翻译列表默认 ORDER BY created_at DESC 且只看存活行，补 partial index
--    （现有 idx_translations_favorite 前缀是 is_favorite，无法覆盖该排序）
CREATE INDEX IF NOT EXISTS idx_translations_created_alive
    ON translations(created_at DESC)
    WHERE deleted_at IS NULL;

-- 3. 覆盖翻译按文件夹列表的过滤与排序（对齐 note 的同类索引）
CREATE INDEX IF NOT EXISTS idx_folder_items_translation_folder_sort_active
    ON folder_items(folder_id, sort_order, item_id)
    WHERE item_type = 'translation' AND deleted_at IS NULL;
