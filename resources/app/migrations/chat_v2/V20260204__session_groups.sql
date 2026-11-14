-- ============================================================================
-- Chat V2: 会话分组
-- ============================================================================

-- 1. 新增会话分组表
CREATE TABLE IF NOT EXISTS chat_v2_session_groups (
    id TEXT PRIMARY KEY,                          -- 分组 ID（格式：group_{uuid}）
    name TEXT NOT NULL,                           -- 分组名称
    description TEXT,                             -- 分组描述
    icon TEXT,                                   -- 图标（emoji 或图标名）
    color TEXT,                                   -- 主题色（可选）
    system_prompt TEXT,                           -- 分组默认 System Prompt
    default_skill_ids_json TEXT DEFAULT '[]',     -- 默认加载的 Skill IDs（JSON 数组）
    workspace_id TEXT,                            -- 可选：所属工作区（NULL 表示全局）
    sort_order INTEGER DEFAULT 0,                 -- 排序顺序（升序）
    persist_status TEXT DEFAULT 'active',         -- 状态（active/archived/deleted）
    created_at TEXT NOT NULL,                     -- 创建时间（ISO 8601）
    updated_at TEXT NOT NULL                      -- 更新时间（ISO 8601）
);

-- 2. 为会话表新增分组字段
ALTER TABLE chat_v2_sessions ADD COLUMN group_id TEXT;

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_sort_order ON chat_v2_session_groups(sort_order);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_status ON chat_v2_session_groups(persist_status);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_workspace ON chat_v2_session_groups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_group_id ON chat_v2_sessions(group_id);
