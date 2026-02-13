-- ============================================================================
-- Mistakes Database Schema V001 (Complete Initial Schema)
-- Generated: 2026-01-30
-- This migration creates all tables, indexes, and triggers for the mistakes.db
-- database. It consolidates all historical migrations (v1 through v30) into a
-- single idempotent schema definition.
-- ============================================================================

-- ============================================================================
-- Core Tables
-- ============================================================================

-- 错题主表 (Main mistakes table)
CREATE TABLE IF NOT EXISTS mistakes (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    question_images TEXT NOT NULL,           -- JSON数组: 题目图片路径
    analysis_images TEXT NOT NULL,           -- JSON数组: 解析图片路径
    user_question TEXT NOT NULL,
    ocr_text TEXT NOT NULL,
    ocr_note TEXT,
    tags TEXT NOT NULL,                      -- JSON数组: 标签列表
    mistake_type TEXT NOT NULL,
    status TEXT NOT NULL,
    chat_category TEXT NOT NULL DEFAULT 'analysis',
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
    chat_metadata TEXT,
    exam_sheet TEXT,                         -- 关联的试卷ID
    autosave_signature TEXT,
    mistake_summary TEXT,                    -- 错题总结
    user_error_analysis TEXT,                -- 用户错误分析
    irec_card_id TEXT,                       -- Irec卡片关联ID
    irec_status INTEGER DEFAULT 0            -- Irec同步状态
);

-- 错题聊天消息表 (Chat messages for mistakes)
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    thinking_content TEXT,                   -- 思维链内容
    rag_sources TEXT,                        -- RAG来源信息(JSON)
    memory_sources TEXT,                     -- 智能记忆来源信息(JSON)
    graph_sources TEXT,                      -- 图谱来源信息(JSON)
    web_search_sources TEXT,                 -- 网络搜索来源信息(JSON)
    image_paths TEXT,                        -- 图片路径数组(JSON)
    image_base64 TEXT,                       -- 图片Base64数组(JSON)
    doc_attachments TEXT,                    -- 文档附件信息(JSON)
    tool_call TEXT,                          -- 工具调用信息(JSON)
    tool_result TEXT,                        -- 工具结果信息(JSON)
    overrides TEXT,                          -- 覆盖配置(JSON)
    relations TEXT,                          -- 消息关系(JSON)
    stable_id TEXT,                          -- 稳定ID用于UPSERT
    turn_id TEXT,                            -- 对话轮次ID
    turn_seq SMALLINT,                       -- 轮次内序号
    reply_to_msg_id INTEGER,                 -- 回复消息ID
    message_kind TEXT,                       -- 消息类型
    lifecycle TEXT,                          -- 消息生命周期状态
    metadata TEXT,                           -- 额外元数据(JSON)
    FOREIGN KEY(mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
);

-- 临时会话表 (Temporary sessions for streaming)
CREATE TABLE IF NOT EXISTS temp_sessions (
    temp_id TEXT PRIMARY KEY,
    session_data TEXT NOT NULL,
    stream_state TEXT NOT NULL DEFAULT 'in_progress',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT
);

-- ============================================================================
-- Review Analysis Tables
-- ============================================================================

-- 回顾分析表 (Consolidated review analysis)
CREATE TABLE IF NOT EXISTS review_analyses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    mistake_ids TEXT NOT NULL,               -- JSON数组: 关联的错题ID
    consolidated_input TEXT NOT NULL,        -- 合并后的输入内容
    user_question TEXT NOT NULL,
    status TEXT NOT NULL,
    tags TEXT NOT NULL,                      -- JSON数组
    analysis_type TEXT NOT NULL DEFAULT 'consolidated_review',
    temp_session_data TEXT,                  -- 临时会话数据(JSON)
    session_sequence INTEGER DEFAULT 0       -- 会话序列号
);

-- 回顾分析聊天消息表
CREATE TABLE IF NOT EXISTS review_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_analysis_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    thinking_content TEXT,                   -- 思维链内容
    rag_sources TEXT,                        -- RAG来源信息(JSON)
    memory_sources TEXT,                     -- 智能记忆来源信息(JSON)
    web_search_sources TEXT,                 -- 网络搜索来源信息(JSON)
    image_paths TEXT,                        -- 图片路径数组(JSON)
    image_base64 TEXT,                       -- 图片Base64数组(JSON)
    doc_attachments TEXT,                    -- 文档附件信息(JSON)
    tool_call TEXT,                          -- 工具调用信息(JSON)
    tool_result TEXT,                        -- 工具结果信息(JSON)
    overrides TEXT,                          -- 覆盖配置(JSON)
    relations TEXT,                          -- 消息关系(JSON)
    FOREIGN KEY(review_analysis_id) REFERENCES review_analyses(id) ON DELETE CASCADE
);

-- 错题整理会话表 (Note review sessions)
CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 会话错题关联表
CREATE TABLE IF NOT EXISTS review_session_mistakes (
    session_id TEXT NOT NULL,
    mistake_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, mistake_id),
    FOREIGN KEY (session_id) REFERENCES review_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
);

-- ============================================================================
-- Settings & Configuration Tables
-- ============================================================================

-- 应用设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- RAG配置表
CREATE TABLE IF NOT EXISTS rag_configurations (
    id TEXT PRIMARY KEY,
    chunk_size INTEGER NOT NULL DEFAULT 512,
    chunk_overlap INTEGER NOT NULL DEFAULT 50,
    chunking_strategy TEXT NOT NULL DEFAULT 'fixed_size',
    min_chunk_size INTEGER NOT NULL DEFAULT 20,
    default_top_k INTEGER NOT NULL DEFAULT 5,
    default_rerank_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ============================================================================
-- Anki Card Generation Tables
-- ============================================================================

-- 文档处理任务表
CREATE TABLE IF NOT EXISTS document_tasks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    original_document_name TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    content_segment TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    error_message TEXT,
    anki_generation_options_json TEXT NOT NULL
);

-- Anki卡片表
CREATE TABLE IF NOT EXISTS anki_cards (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES document_tasks(id) ON DELETE CASCADE,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    tags_json TEXT DEFAULT '[]',
    images_json TEXT DEFAULT '[]',
    is_error_card INTEGER NOT NULL DEFAULT 0,
    error_content TEXT,
    card_order_in_task INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    extra_fields_json TEXT DEFAULT '{}',
    template_id TEXT,
    source_type TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    text TEXT                                -- Cloze模板文本
);

-- 自定义Anki模板表
CREATE TABLE IF NOT EXISTS custom_anki_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    author TEXT,
    version TEXT NOT NULL DEFAULT '1.0.0',
    preview_front TEXT NOT NULL,
    preview_back TEXT NOT NULL,
    note_type TEXT NOT NULL DEFAULT 'Basic',
    fields_json TEXT NOT NULL DEFAULT '[]',
    generation_prompt TEXT NOT NULL,
    front_template TEXT NOT NULL,
    back_template TEXT NOT NULL,
    css_style TEXT NOT NULL,
    field_extraction_rules_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_active INTEGER NOT NULL DEFAULT 1,
    is_built_in INTEGER NOT NULL DEFAULT 0
);

-- 文档控制状态表 (Document processing state)
CREATE TABLE IF NOT EXISTS document_control_states (
    document_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    pending_tasks_json TEXT NOT NULL DEFAULT '[]',
    running_tasks_json TEXT NOT NULL DEFAULT '{}',
    completed_tasks_json TEXT NOT NULL DEFAULT '[]',
    failed_tasks_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Vector & Search Tables
-- ============================================================================

-- 向量化数据表
CREATE TABLE IF NOT EXISTS vectorized_data (
    id TEXT PRIMARY KEY,
    mistake_id TEXT NOT NULL,
    text_content TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE
);

-- 分库表 (Sub-libraries for RAG)
CREATE TABLE IF NOT EXISTS rag_sub_libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 搜索日志表
CREATE TABLE IF NOT EXISTS search_logs (
    id TEXT PRIMARY KEY,
    search_type TEXT NOT NULL,
    query TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    execution_time_ms INTEGER NOT NULL,
    mistake_ids_json TEXT,
    error_message TEXT,
    user_feedback TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Exam Sheet Tables
-- ============================================================================

-- 试卷会话表
CREATE TABLE IF NOT EXISTS exam_sheet_sessions (
    id TEXT PRIMARY KEY,
    exam_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    temp_id TEXT NOT NULL,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    linked_mistake_ids TEXT
);

-- ============================================================================
-- Migration Progress Table (for data migration tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS migration_progress (
    category TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_cursor TEXT,
    total_processed INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Mistakes indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_mistakes_irec_card_id 
    ON mistakes(irec_card_id) WHERE irec_card_id IS NOT NULL;

-- Chat messages indexes
CREATE INDEX IF NOT EXISTS idx_chat_turn_id ON chat_messages(turn_id);
CREATE INDEX IF NOT EXISTS idx_chat_turn_pair ON chat_messages(mistake_id, turn_id);

-- Document tasks indexes
CREATE INDEX IF NOT EXISTS idx_document_tasks_document_id ON document_tasks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status);

-- Anki cards indexes
CREATE INDEX IF NOT EXISTS idx_anki_cards_task_id ON anki_cards(task_id);
CREATE INDEX IF NOT EXISTS idx_anki_cards_is_error_card ON anki_cards(is_error_card);
CREATE INDEX IF NOT EXISTS idx_anki_cards_source ON anki_cards(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text);

-- Custom Anki templates indexes
CREATE INDEX IF NOT EXISTS idx_custom_anki_templates_is_active ON custom_anki_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_custom_anki_templates_is_built_in ON custom_anki_templates(is_built_in);

-- Document control states indexes
CREATE INDEX IF NOT EXISTS idx_document_control_states_state ON document_control_states(state);
CREATE INDEX IF NOT EXISTS idx_document_control_states_updated_at ON document_control_states(updated_at);

-- Vectorized data indexes
CREATE INDEX IF NOT EXISTS idx_vectorized_data_mistake_id ON vectorized_data(mistake_id);

-- Review session mistakes indexes
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_session_id ON review_session_mistakes(session_id);
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_mistake_id ON review_session_mistakes(mistake_id);

-- Search logs indexes
CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_search_logs_search_type ON search_logs(search_type);

-- Exam sheet sessions indexes
CREATE INDEX IF NOT EXISTS idx_exam_sheet_sessions_status ON exam_sheet_sessions(status);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Auto-update document_control_states.updated_at on update
CREATE TRIGGER IF NOT EXISTS update_document_control_states_timestamp 
    AFTER UPDATE ON document_control_states
    BEGIN
        UPDATE document_control_states SET updated_at = CURRENT_TIMESTAMP WHERE document_id = NEW.document_id;
    END;
