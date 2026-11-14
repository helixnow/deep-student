-- ============================================================================
-- 性能优化：向量化状态查询专用索引
-- ============================================================================
-- vfs_get_all_index_status 使用 LEFT JOIN files ON files.id = r.source_id
-- 现有的 idx_resources_source 是 (source_table, source_id) 复合索引，
-- 无法用于仅按 source_id 查找的场景。
-- 新增 resources(source_id) 单列索引以加速 JOIN。
CREATE INDEX IF NOT EXISTS idx_resources_source_id ON resources(source_id);

-- exam_sheets 同样需要通过 id 快速匹配 r.source_id（已有 PK 覆盖，无需额外索引）
-- files 的 PK 是 id，已覆盖 LEFT JOIN files fs ON fs.id = r.source_id
-- notes/translations/essays/mindmaps 已有 resource_id 索引
