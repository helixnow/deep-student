-- ============================================================================
-- Chat V2: 课题首选 runtime root
-- ============================================================================
-- default_runtime_root_id: 同步（LWW）；workspace 或 authorized_*；未绑定为 NULL
-- preferred_project_root_path: 本机展示用绝对路径缓存；跨机不同步（local-derived）

ALTER TABLE chat_v2_session_groups
ADD COLUMN default_runtime_root_id TEXT;

ALTER TABLE chat_v2_session_groups
ADD COLUMN preferred_project_root_path TEXT;
