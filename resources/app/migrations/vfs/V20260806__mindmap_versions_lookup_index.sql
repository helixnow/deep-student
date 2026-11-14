-- ============================================================================
-- V20260806: mindmap_versions 复合查询索引
-- ============================================================================
--
-- 背景：
--   自动保存合并窗口检查（VfsMindMapRepo::latest_version_in_merge_window）、
--   版本列表分页（get_versions_paged）与保留策略清理（prune_autosave_versions）
--   都是 `WHERE mindmap_id = ? ORDER BY created_at DESC, version_id DESC` 形态，
--   且合并窗口检查发生在**每次**内容自动保存上。既有 idx_mindmap_versions_mindmap
--   只覆盖等值过滤，排序仍需临时 sort；chat% 来源版本被聊天引用（mv_*）
--   永久保留、不参与清理，重度使用下单导图版本行数可持续增长，排序开销随之放大。
--
-- 幂等性：CREATE INDEX IF NOT EXISTS；纯加索引，无数据/结构变更，向后兼容。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mindmap_versions_mindmap_created
    ON mindmap_versions(mindmap_id, created_at DESC, version_id DESC);
