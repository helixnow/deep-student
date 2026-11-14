-- 为 chat_v2_session_state 添加结构化 Skill 状态字段
ALTER TABLE chat_v2_session_state ADD COLUMN skill_state_json TEXT;

-- 从 legacy 字段回填最小结构化状态
UPDATE chat_v2_session_state
SET skill_state_json = json_object(
    'manualPinnedSkillIds', json(COALESCE(active_skill_ids_json, '[]')),
    'modeRequiredBundleIds', json('[]'),
    'agenticSessionSkillIds', json(COALESCE(loaded_skill_ids_json, '[]')),
    'branchLocalSkillIds', json('[]'),
    'effectiveAllowedInternalTools', json('[]'),
    'effectiveAllowedExternalTools', json('[]'),
    'effectiveAllowedExternalServers', json('[]'),
    'version', 0,
    'legacyMigrated', 1
)
WHERE skill_state_json IS NULL;
