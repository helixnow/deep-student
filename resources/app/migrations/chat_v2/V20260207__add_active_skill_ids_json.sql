-- ============================================================================
-- Chat V2: 添加 active_skill_ids_json（多选技能支持）
-- ============================================================================

ALTER TABLE chat_v2_session_state
ADD COLUMN active_skill_ids_json TEXT;

-- 兼容旧的单选字段 active_skill_id
UPDATE chat_v2_session_state
SET active_skill_ids_json = '["' || replace(active_skill_id, '"', '\\"') || '"]'
WHERE (active_skill_ids_json IS NULL OR active_skill_ids_json = '')
  AND active_skill_id IS NOT NULL
  AND trim(active_skill_id) != '';
