-- ============================================================================
-- Chat V2 数据库完整 Schema
-- ============================================================================
-- 版本: V20260130_001
-- 描述: 合并自 001-015 迁移文件的完整表结构
-- 日期: 2026-01-30
-- 
-- 表清单:
--   1. chat_v2_sessions       - 会话表
--   2. chat_v2_messages       - 消息表
--   3. chat_v2_blocks         - 块表
--   4. chat_v2_attachments    - 附件表
--   5. chat_v2_session_state  - 会话状态表
--   6. chat_v2_session_mistakes - 会话-错题关联表
--   7. resources              - 资源库表
--   8. chat_v2_todo_lists     - TodoList 状态表
--   9. workspace_index        - 工作区索引表
--  10. sleep_block            - 睡眠块表
--  11. subagent_task          - 子代理任务表
-- ============================================================================

-- ============================================================================
-- 1. 会话表
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_sessions (
    id TEXT PRIMARY KEY,                               -- 会话 ID（格式：sess_{uuid}）
    mode TEXT NOT NULL,                                -- 会话模式（analysis/review/textbook/bridge/general_chat）
    title TEXT,                                        -- 会话标题（可选）
    persist_status TEXT NOT NULL DEFAULT 'active',     -- 持久化状态（active/archived/deleted）
    created_at TEXT NOT NULL,                          -- 创建时间（ISO 8601）
    updated_at TEXT NOT NULL,                          -- 更新时间（ISO 8601）
    metadata_json TEXT,                                -- 扩展元数据（JSON 格式）
    -- 以下字段来自 007_session_description.sql
    description TEXT,                                  -- 会话简介（用于预览展示）
    summary_hash TEXT,                                 -- 上次生成摘要时的内容哈希（用于防重复生成）
    -- 以下字段来自 012_workspace_index.sql
    workspace_id TEXT                                  -- 关联的工作区 ID
);

-- 会话索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_mode ON chat_v2_sessions(mode);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_persist_status ON chat_v2_sessions(persist_status);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_created_at ON chat_v2_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_updated_at ON chat_v2_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON chat_v2_sessions(workspace_id);

-- ============================================================================
-- 2. 消息表
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_messages (
    id TEXT PRIMARY KEY,                               -- 消息 ID（格式：msg_{uuid}）
    session_id TEXT NOT NULL,                          -- 所属会话 ID
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),  -- 消息角色
    block_ids_json TEXT NOT NULL DEFAULT '[]',         -- 块 ID 列表（JSON 数组，有序）
    timestamp INTEGER NOT NULL,                        -- 创建时间戳（毫秒）
    persistent_stable_id TEXT,                         -- 持久化稳定 ID
    parent_id TEXT,                                    -- 编辑/重试分支的父消息 ID
    supersedes TEXT,                                   -- 替代的消息 ID
    meta_json TEXT,                                    -- 消息元数据（JSON 格式）
    attachments_json TEXT,                             -- 附件列表（JSON 格式）
    -- 以下字段来自 003_variants.sql（多模型并行变体支持）
    active_variant_id TEXT,                            -- 当前激活的变体 ID
    variants_json TEXT,                                -- 变体列表（JSON 数组）
    shared_context_json TEXT,                          -- 共享上下文（JSON 对象）
    FOREIGN KEY(session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE
);

-- 消息索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_session_id ON chat_v2_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_timestamp ON chat_v2_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_role ON chat_v2_messages(role);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_parent_id ON chat_v2_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_active_variant_id ON chat_v2_messages(active_variant_id);
-- 性能优化索引（来自 008_performance_indexes.sql）
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_session_timestamp ON chat_v2_messages(session_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_session_id_id ON chat_v2_messages(session_id, id);

-- ============================================================================
-- 3. 块表
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_blocks (
    id TEXT PRIMARY KEY,                               -- 块 ID（格式：blk_{uuid}）
    message_id TEXT NOT NULL,                          -- 所属消息 ID
    block_type TEXT NOT NULL,                          -- 块类型（thinking/content/rag/mcp_tool 等）
    status TEXT NOT NULL DEFAULT 'pending',            -- 块状态（pending/running/success/error）
    block_index INTEGER NOT NULL DEFAULT 0,            -- 块顺序
    content TEXT,                                      -- 流式内容
    tool_name TEXT,                                    -- 工具名称
    tool_input_json TEXT,                              -- 工具输入（JSON 格式）
    tool_output_json TEXT,                             -- 工具输出（JSON 格式）
    citations_json TEXT,                               -- 引用来源（JSON 数组）
    error TEXT,                                        -- 错误信息
    started_at INTEGER,                                -- 开始时间戳（毫秒）
    ended_at INTEGER,                                  -- 结束时间戳（毫秒）
    -- 以下字段来自 003_variants.sql
    variant_id TEXT,                                   -- 块所属的变体 ID（多变体模式下）
    -- 以下字段来自 010_first_chunk_at.sql
    first_chunk_at INTEGER,                            -- 第一次收到有效内容的时间戳（用于精确排序）
    FOREIGN KEY(message_id) REFERENCES chat_v2_messages(id) ON DELETE CASCADE
);

-- 块索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_message_id ON chat_v2_blocks(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_block_type ON chat_v2_blocks(block_type);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_status ON chat_v2_blocks(status);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_order ON chat_v2_blocks(message_id, block_index);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_variant_id ON chat_v2_blocks(variant_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_first_chunk_at ON chat_v2_blocks(first_chunk_at);

-- ============================================================================
-- 4. 附件表
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_attachments (
    id TEXT PRIMARY KEY,                               -- 附件 ID（格式：att_{uuid}）
    message_id TEXT NOT NULL,                          -- 所属消息 ID
    name TEXT NOT NULL,                                -- 文件名
    type TEXT NOT NULL,                                -- 附件类型（image/document/audio/video/other）
    mime_type TEXT NOT NULL,                           -- MIME 类型
    size INTEGER NOT NULL,                             -- 文件大小（字节）
    status TEXT NOT NULL DEFAULT 'pending',            -- 上传状态（pending/uploading/ready/error）
    preview_url TEXT,                                  -- 预览 URL 或 base64
    storage_path TEXT,                                 -- 存储路径
    error TEXT,                                        -- 错误信息
    content_hash TEXT,                                 -- 内容哈希（用于去重）
    created_at TEXT NOT NULL,                          -- 创建时间（ISO 8601）
    -- 以下字段来自 002_schema_alignment.sql
    block_id TEXT,                                     -- 关联的块 ID（支持块级附件关联）
    FOREIGN KEY(message_id) REFERENCES chat_v2_messages(id) ON DELETE CASCADE,
    FOREIGN KEY(block_id) REFERENCES chat_v2_blocks(id) ON DELETE CASCADE
);

-- 附件索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_message_id ON chat_v2_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_type ON chat_v2_attachments(type);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_status ON chat_v2_attachments(status);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_block_id ON chat_v2_attachments(block_id);

-- ============================================================================
-- 5. 会话状态表（存储前端 UI 状态）
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_session_state (
    session_id TEXT PRIMARY KEY,                       -- 会话 ID
    chat_params_json TEXT,                             -- 聊天参数（JSON 格式）
    features_json TEXT,                                -- 功能开关 Map（JSON 格式）
    mode_state_json TEXT,                              -- 模式状态（JSON 格式）
    input_value TEXT,                                  -- 输入框草稿
    panel_states_json TEXT,                            -- 面板状态（JSON 格式）
    updated_at TEXT NOT NULL,                          -- 更新时间（ISO 8601）
    -- 以下字段来自 002_schema_alignment.sql（ChatParams 独立字段）
    model_id TEXT,                                     -- 模型 ID
    temperature REAL DEFAULT 0.7,                      -- 温度参数
    context_limit INTEGER DEFAULT 8192,                -- 上下文限制
    max_tokens INTEGER DEFAULT 4096,                   -- 最大 tokens
    enable_thinking INTEGER DEFAULT 0,                 -- 启用思考模式
    disable_tools INTEGER DEFAULT 0,                   -- 禁用工具
    model2_override_id TEXT,                           -- 模型2覆盖 ID
    attachments_json TEXT,                             -- 附件草稿（JSON 格式）
    -- RAG/工具相关
    rag_enabled INTEGER DEFAULT 1,                     -- RAG 启用
    rag_library_ids_json TEXT,                         -- RAG 库 ID 列表（JSON）
    rag_top_k INTEGER DEFAULT 5,                       -- RAG Top K
    graph_rag_enabled INTEGER DEFAULT 1,               -- 图 RAG 启用
    memory_enabled INTEGER DEFAULT 1,                  -- 记忆启用
    web_search_enabled INTEGER DEFAULT 0,              -- 网页搜索启用
    -- Anki 相关
    anki_enabled INTEGER DEFAULT 0,                    -- Anki 启用
    anki_template_id TEXT,                             -- Anki 模板 ID
    anki_options_json TEXT,                            -- Anki 选项（JSON）
    -- 以下字段来自 004_context_refs.sql
    pending_context_refs_json TEXT,                    -- 瞬态上下文引用（JSON 格式）
    -- 以下字段来自 013_loaded_skill_ids.sql
    loaded_skill_ids_json TEXT DEFAULT NULL,           -- 已加载 Skill IDs（JSON 格式）
    -- 以下字段来自 014_active_skill_id.sql
    active_skill_id TEXT DEFAULT NULL,                 -- 手动激活的 Skill ID
    FOREIGN KEY(session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE
);

-- ============================================================================
-- 6. 会话-错题关联表（用于 analysis 模式）
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_session_mistakes (
    session_id TEXT NOT NULL,                          -- 会话 ID
    mistake_id TEXT NOT NULL,                          -- 错题 ID
    relation_type TEXT NOT NULL DEFAULT 'primary',     -- 关联类型（primary/bridge）
    created_at TEXT NOT NULL,                          -- 创建时间（ISO 8601）
    PRIMARY KEY (session_id, mistake_id),
    FOREIGN KEY (session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_mistake ON chat_v2_session_mistakes(mistake_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_type ON chat_v2_session_mistakes(relation_type);

-- ============================================================================
-- 7. 资源库表
-- ============================================================================
-- 存储所有上下文内容（图片、文件、笔记快照、题目卡片快照、检索结果）
-- 基于内容哈希自动去重，通过 resourceId + hash 精确定位任意版本
CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,                               -- 资源 ID（格式：res_{nanoid(10)}）
    hash TEXT NOT NULL UNIQUE,                         -- 内容哈希（SHA-256，用于去重）
    type TEXT NOT NULL CHECK(type IN ('image', 'file', 'note', 'card', 'retrieval')),
                                                       -- 资源类型
    source_id TEXT,                                    -- 原始数据 ID（noteId, cardId 等，用于跳转定位）
    data TEXT,                                         -- 实际内容（文本或 Base64 编码的二进制）
    metadata_json TEXT,                                -- 元数据（JSON 格式）
    ref_count INTEGER NOT NULL DEFAULT 0,              -- 引用计数（消息保存时 +1，删除时 -1）
    created_at INTEGER NOT NULL                        -- 创建时间戳（毫秒）
);

-- 资源索引
CREATE INDEX IF NOT EXISTS idx_resources_hash ON resources(hash);
CREATE INDEX IF NOT EXISTS idx_resources_source_id ON resources(source_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_ref_count ON resources(ref_count);
CREATE INDEX IF NOT EXISTS idx_resources_created_at ON resources(created_at);

-- ============================================================================
-- 8. TodoList 状态表（按会话隔离）
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_v2_todo_lists (
    session_id TEXT PRIMARY KEY,                       -- 会话 ID（一个会话只能有一个活跃 TodoList）
    message_id TEXT NOT NULL,                          -- 关联的助手消息 ID
    variant_id TEXT,                                   -- 关联的变体 ID（可选）
    todo_list_id TEXT NOT NULL,                        -- TodoList ID
    title TEXT NOT NULL,                               -- 任务标题
    steps_json TEXT NOT NULL,                          -- 步骤列表（JSON 数组）
    is_all_done INTEGER NOT NULL DEFAULT 0,            -- 是否全部完成（0=否，1=是）
    created_at INTEGER NOT NULL,                       -- 创建时间戳（毫秒）
    updated_at INTEGER NOT NULL,                       -- 更新时间戳（毫秒）
    FOREIGN KEY(session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES chat_v2_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_todo_lists_message_id ON chat_v2_todo_lists(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_todo_lists_is_all_done ON chat_v2_todo_lists(is_all_done);

-- ============================================================================
-- 9. 工作区索引表
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspace_index (
    workspace_id TEXT PRIMARY KEY,                     -- 工作区 ID
    name TEXT,                                         -- 工作区名称
    status TEXT NOT NULL DEFAULT 'active',             -- 状态
    creator_session_id TEXT NOT NULL,                  -- 创建者会话 ID
    created_at TEXT NOT NULL,                          -- 创建时间
    updated_at TEXT NOT NULL                           -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_workspace_index_status ON workspace_index(status);
CREATE INDEX IF NOT EXISTS idx_workspace_index_creator ON workspace_index(creator_session_id);

-- ============================================================================
-- 10. 睡眠块表（用于持久化主代理的睡眠状态）
-- ============================================================================
CREATE TABLE IF NOT EXISTS sleep_block (
    id TEXT PRIMARY KEY,                               -- 睡眠块 ID
    workspace_id TEXT NOT NULL,                        -- 工作区 ID
    coordinator_session_id TEXT NOT NULL,              -- 协调者会话 ID
    awaiting_agents TEXT NOT NULL DEFAULT '[]',        -- 等待的子代理 session_id 列表（JSON 数组）
    wake_condition TEXT NOT NULL DEFAULT '{"type":"result_message"}',  -- 唤醒条件（JSON）
    status TEXT NOT NULL DEFAULT 'sleeping',           -- 状态：sleeping, awakened, timeout, cancelled
    timeout_at TEXT,                                   -- 超时时间戳（可选）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),-- 创建时间
    awakened_at TEXT,                                  -- 唤醒时间
    awakened_by TEXT,                                  -- 唤醒者的 session_id
    awaken_message TEXT,                               -- 唤醒时的消息内容摘要
    message_id TEXT,                                   -- 关联的消息 ID（用于前端定位块）
    block_id TEXT,                                     -- 关联的块 ID
    FOREIGN KEY (workspace_id) REFERENCES workspace_index(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sleep_block_status ON sleep_block(status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_workspace ON sleep_block(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sleep_block_coordinator ON sleep_block(coordinator_session_id);

-- ============================================================================
-- 11. 子代理任务表（记录需要恢复的子代理任务）
-- ============================================================================
CREATE TABLE IF NOT EXISTS subagent_task (
    id TEXT PRIMARY KEY,                               -- 任务 ID
    workspace_id TEXT NOT NULL,                        -- 工作区 ID
    agent_session_id TEXT NOT NULL,                    -- 代理会话 ID
    skill_id TEXT,                                     -- Skill ID
    status TEXT NOT NULL DEFAULT 'pending',            -- 任务状态：pending, running, completed, failed
    task_content TEXT,                                 -- 原始任务内容
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),  -- 最后活跃时间
    needs_recovery INTEGER NOT NULL DEFAULT 0,         -- 是否需要恢复
    created_at TEXT NOT NULL DEFAULT (datetime('now')),-- 创建时间
    FOREIGN KEY (workspace_id) REFERENCES workspace_index(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subagent_task_status ON subagent_task(status);
CREATE INDEX IF NOT EXISTS idx_subagent_task_recovery ON subagent_task(needs_recovery) WHERE needs_recovery = 1;
