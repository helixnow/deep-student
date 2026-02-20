-- ============================================================================
-- Chat V2: 分组关联来源（pinned resources）
-- ============================================================================

ALTER TABLE chat_v2_session_groups
ADD COLUMN pinned_resource_ids_json TEXT DEFAULT '[]';
