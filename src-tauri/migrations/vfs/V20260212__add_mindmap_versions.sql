-- ============================================================================
-- 思维导图版本表
-- ============================================================================
-- 记录思维导图的历史版本，版本内容通过 resource_id 关联到 resources 表。
-- 设计参照 notes_versions 表，在 mindmap 内容更新时自动保存旧版本快照。
-- ============================================================================

CREATE TABLE IF NOT EXISTS mindmap_versions (
    version_id TEXT PRIMARY KEY,                  -- 格式：mv_{nanoid(10)}
    mindmap_id TEXT NOT NULL,                     -- 关联的思维导图 ID
    resource_id TEXT NOT NULL,                    -- 版本内容存 resources.data
    title TEXT NOT NULL,                          -- 当时的标题
    label TEXT,                                   -- 版本标签（可选，如 'v1.0'）
    source TEXT,                                  -- 来源：'chat_update' | 'chat_edit_nodes' | 'manual' | 'auto'
    created_at TEXT NOT NULL,                     -- 版本创建时间（ISO8601）
    FOREIGN KEY (mindmap_id) REFERENCES mindmaps(id) ON DELETE CASCADE,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_mindmap_versions_mindmap ON mindmap_versions(mindmap_id);
CREATE INDEX IF NOT EXISTS idx_mindmap_versions_resource ON mindmap_versions(resource_id);
CREATE INDEX IF NOT EXISTS idx_mindmap_versions_created ON mindmap_versions(created_at DESC);
