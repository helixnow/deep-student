-- ============================================================================
-- VFS 初始化 Schema (V20260130_001__init.sql)
-- ============================================================================
-- 
-- 由 36 个迁移文件合并生成的完整 VFS 数据库 Schema。
-- Refinery 自动管理迁移版本，无需手动维护 vfs_migrations 表。
--
-- 生成时间：2026-01-30
-- 包含表：27 个
-- 包含视图：1 个
-- 包含虚拟表(FTS5)：1 个
-- ============================================================================

-- ============================================================================
-- 1. 资源表（核心 SSOT）
-- ============================================================================
CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,                          -- 格式：res_{nanoid(10)}
    hash TEXT NOT NULL UNIQUE,                    -- SHA-256，全局去重
    type TEXT NOT NULL,                           -- note | file | exam | translation | essay | retrieval
    source_id TEXT,                               -- 原始数据 ID
    source_table TEXT,                            -- 原始表名
    storage_mode TEXT NOT NULL DEFAULT 'inline',  -- inline | external
    data TEXT,                                    -- 内嵌内容（inline 模式）
    external_hash TEXT,                           -- 外部文件哈希（external 模式）
    metadata_json TEXT,                           -- JSON 格式元数据
    ref_count INTEGER NOT NULL DEFAULT 0,         -- 引用计数
    created_at INTEGER NOT NULL,                  -- 创建时间（毫秒）
    updated_at INTEGER NOT NULL,                  -- 更新时间（毫秒）
    deleted_at INTEGER,                           -- 软删除时间戳
    deleted_reason TEXT,                          -- 删除原因
    -- 文本索引状态
    index_state TEXT DEFAULT 'pending',           -- pending | indexing | indexed | failed | disabled
    index_hash TEXT,                              -- 最后索引时的内容哈希
    index_error TEXT,                             -- 索引失败时的错误信息
    indexed_at INTEGER,                           -- 最后索引完成时间
    index_retry_count INTEGER DEFAULT 0,          -- 索引重试次数
    -- OCR 字段
    ocr_text TEXT,                                -- OCR 文本（单页资源）
    -- 多模态索引字段（已废弃，保留兼容）
    mm_index_state TEXT,
    mm_index_error TEXT,
    mm_index_retry_count INTEGER DEFAULT 0,
    mm_embedding_dim INTEGER,
    mm_indexing_mode TEXT,
    mm_indexed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_resources_hash ON resources(hash);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_source ON resources(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_updated ON resources(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_storage_mode ON resources(storage_mode);
CREATE INDEX IF NOT EXISTS idx_resources_deleted ON resources(deleted_at);
CREATE INDEX IF NOT EXISTS idx_resources_index_state ON resources(index_state);
CREATE INDEX IF NOT EXISTS idx_resources_indexed_at ON resources(indexed_at);
CREATE INDEX IF NOT EXISTS idx_resources_has_ocr ON resources(id) WHERE ocr_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resources_mm_indexed ON resources(mm_indexed_at);
CREATE INDEX IF NOT EXISTS idx_resources_mm_index_state ON resources(mm_index_state);

-- ============================================================================
-- 2. 笔记元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,                          -- 格式：note_{nanoid(10)}
    resource_id TEXT NOT NULL,                    -- 内容存 resources
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',              -- JSON 数组
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,                     -- ISO 8601 格式
    updated_at TEXT NOT NULL,
    deleted_at TEXT,                              -- 软删除
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_notes_resource ON notes(resource_id);
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_favorite ON notes(is_favorite, updated_at DESC);

-- ============================================================================
-- 3. 笔记版本表
-- ============================================================================
CREATE TABLE IF NOT EXISTS notes_versions (
    version_id TEXT PRIMARY KEY,                  -- 格式：ver_{nanoid(10)}
    note_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,                    -- 版本内容存 resources
    title TEXT NOT NULL,
    tags TEXT NOT NULL,
    label TEXT,                                   -- 版本标签
    created_at TEXT NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_notes_versions_note ON notes_versions(note_id);
CREATE INDEX IF NOT EXISTS idx_notes_versions_resource ON notes_versions(resource_id);
CREATE INDEX IF NOT EXISTS idx_notes_versions_created ON notes_versions(created_at DESC);

-- ============================================================================
-- 4. 文件统一存储表（原 textbooks + attachments 合并）
-- ============================================================================
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,                          -- 格式：file_{nanoid(10)}
    resource_id TEXT,                             -- 关联资源
    blob_hash TEXT,                               -- PDF 内容指向 blobs
    sha256 TEXT NOT NULL UNIQUE,                  -- 文件哈希（去重用）
    file_name TEXT NOT NULL,                      -- 原始文件名
    original_path TEXT,                           -- 原始导入路径
    size INTEGER NOT NULL,                        -- 文件大小（字节）
    page_count INTEGER,                           -- 页数（PDF）
    tags_json TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0,       -- 收藏（统一字段）
    last_opened_at TEXT,
    last_page INTEGER,
    bookmarks_json TEXT NOT NULL DEFAULT '[]',
    cover_key TEXT,                               -- 封面缓存键
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    -- 统一文件类型
    type TEXT NOT NULL DEFAULT 'document',        -- document | image | audio | video
    name TEXT,                                    -- 显示名称
    content_hash TEXT,                            -- 内容哈希（兼容字段）
    description TEXT,                             -- 描述
    mime_type TEXT,                               -- MIME 类型
    -- PDF 预览和 OCR
    preview_json TEXT,                            -- 页面图片引用
    extracted_text TEXT,                          -- PDF 提取文本
    ocr_pages_json TEXT,                          -- 按页 OCR 文本
    -- 多模态索引字段（已废弃，保留兼容）
    mm_indexed_pages_json TEXT,
    mm_index_state TEXT,
    mm_index_error TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id),
    FOREIGN KEY (blob_hash) REFERENCES blobs(hash)
);

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_resource ON files(resource_id);
CREATE INDEX IF NOT EXISTS idx_files_blob ON files(blob_hash);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_mime_type ON files(mime_type);
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_hash_unique ON files(content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_content_hash_deleted ON files(content_hash) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_has_ocr ON files(id) WHERE ocr_pages_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_mm_indexed ON files(mm_indexed_pages_json IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_files_mm_index_state ON files(mm_index_state);

-- ============================================================================
-- 5. 整卷识别元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS exam_sheets (
    id TEXT PRIMARY KEY,                          -- 格式：exam_{nanoid(10)}
    resource_id TEXT,
    exam_name TEXT,
    status TEXT NOT NULL,                         -- pending | processing | completed | failed
    temp_id TEXT NOT NULL,                        -- 临时会话 ID
    metadata_json TEXT NOT NULL,                  -- 识别元数据
    preview_json TEXT NOT NULL,                   -- 预览数据
    linked_mistake_ids TEXT,                      -- 关联的错题 ID
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    -- OCR 和多模态索引
    ocr_pages_json TEXT,                          -- 按页 OCR 文本
    mm_indexed_pages_json TEXT,                   -- 多模态索引元数据（已废弃）
    mm_index_state TEXT,
    mm_index_error TEXT,
    mm_embedding_dim INTEGER,
    mm_indexing_mode TEXT,
    mm_indexed_at INTEGER,
    -- 同步字段
    sync_enabled INTEGER DEFAULT 0,
    last_synced_at TEXT,
    remote_exam_id TEXT,
    sync_config TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_exam_sheets_resource ON exam_sheets(resource_id);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_status ON exam_sheets(status);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_created ON exam_sheets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_deleted ON exam_sheets(deleted_at);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_favorite ON exam_sheets(is_favorite, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_has_ocr_pages ON exam_sheets(id) WHERE ocr_pages_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exam_sheets_mm_index_state ON exam_sheets(mm_index_state);

-- ============================================================================
-- 6. 翻译元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,                          -- 格式：tr_{nanoid(10)}
    resource_id TEXT NOT NULL,                    -- 内容存 resources
    src_lang TEXT NOT NULL DEFAULT 'auto',
    tgt_lang TEXT NOT NULL DEFAULT 'zh',
    engine TEXT,                                  -- 翻译引擎
    model TEXT,                                   -- 使用的模型
    is_favorite INTEGER NOT NULL DEFAULT 0,
    quality_rating INTEGER,                       -- 1-5 评分
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    title TEXT,                                   -- 翻译标题
    subject TEXT,                                 -- 科目（用于分类）
    updated_at TEXT,
    deleted_at TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_translations_resource ON translations(resource_id);
CREATE INDEX IF NOT EXISTS idx_translations_favorite ON translations(is_favorite, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translations_lang ON translations(src_lang, tgt_lang);
CREATE INDEX IF NOT EXISTS idx_translations_subject ON translations(subject);
CREATE INDEX IF NOT EXISTS idx_translations_deleted ON translations(deleted_at);

-- ============================================================================
-- 7. 作文批改元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS essays (
    id TEXT PRIMARY KEY,                          -- 格式：essay_{nanoid(10)}
    resource_id TEXT NOT NULL,                    -- 内容存 resources
    title TEXT,
    essay_type TEXT,                              -- 作文类型
    grading_result_json TEXT,                     -- 批改结果
    score INTEGER,                                -- 分数
    session_id TEXT,                              -- 会话 ID
    round_number INTEGER NOT NULL DEFAULT 1,      -- 轮次编号
    grade_level TEXT,                             -- 学段
    custom_prompt TEXT,                           -- 自定义 Prompt
    dimension_scores_json TEXT,                   -- 维度评分
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_essays_resource ON essays(resource_id);
CREATE INDEX IF NOT EXISTS idx_essays_created ON essays(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_essays_score ON essays(score DESC);
CREATE INDEX IF NOT EXISTS idx_essays_session ON essays(session_id);
CREATE INDEX IF NOT EXISTS idx_essays_favorite ON essays(is_favorite, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_essays_deleted ON essays(deleted_at);

-- ============================================================================
-- 8. 作文会话元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS essay_sessions (
    id TEXT PRIMARY KEY,                          -- 会话 ID
    title TEXT NOT NULL,
    essay_type TEXT,
    grade_level TEXT,
    custom_prompt TEXT,
    subject TEXT DEFAULT '语文',
    total_rounds INTEGER NOT NULL DEFAULT 0,
    latest_score INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_essay_sessions_favorite ON essay_sessions(is_favorite, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_updated ON essay_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_subject ON essay_sessions(subject);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_deleted ON essay_sessions(deleted_at);

-- ============================================================================
-- 9. 大文件外部存储表
-- ============================================================================
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,                        -- SHA-256
    relative_path TEXT NOT NULL,                  -- 相对于 vfs_blobs 目录的路径
    size INTEGER NOT NULL,                        -- 文件大小（字节）
    mime_type TEXT,                               -- MIME 类型
    ref_count INTEGER NOT NULL DEFAULT 0,         -- 引用计数
    created_at INTEGER NOT NULL                   -- 创建时间戳（毫秒）
);

CREATE INDEX IF NOT EXISTS idx_blobs_mime ON blobs(mime_type);
CREATE INDEX IF NOT EXISTS idx_blobs_ref_count ON blobs(ref_count);

-- ============================================================================
-- 10. 文件夹表
-- ============================================================================
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,                          -- 格式：fld_{nanoid(10)}
    parent_id TEXT,                               -- 父文件夹 ID（NULL 表示根级）
    title TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    is_expanded INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_sort ON folders(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(deleted_at);
CREATE INDEX IF NOT EXISTS idx_folders_favorite ON folders(is_favorite, updated_at DESC);

-- ============================================================================
-- 11. 文件夹内容关联表
-- ============================================================================
CREATE TABLE IF NOT EXISTS folder_items (
    id TEXT PRIMARY KEY,                          -- 格式：fi_{nanoid(10)}
    folder_id TEXT,                               -- 所属文件夹（NULL 表示根级）
    item_type TEXT NOT NULL,                      -- 'note'|'file'|'exam'|'translation'|'essay'|'mindmap'
    item_id TEXT NOT NULL,                        -- 资源 ID
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    cached_path TEXT,                             -- 路径缓存
    deleted_at TEXT,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_folder_items_folder ON folder_items(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_items_type_id ON folder_items(item_type, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_items_unique_v2 ON folder_items(folder_id, item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_folder_items_path ON folder_items(cached_path);
CREATE INDEX IF NOT EXISTS idx_folder_items_deleted ON folder_items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_folder_items_folder_active ON folder_items(folder_id, deleted_at);

-- ============================================================================
-- 12. 路径缓存表
-- ============================================================================
CREATE TABLE IF NOT EXISTS path_cache (
    item_type TEXT NOT NULL,                      -- 'folder' | 'note' | 'file' | ...
    item_id TEXT NOT NULL,
    full_path TEXT NOT NULL,                      -- 完整路径
    folder_path TEXT NOT NULL,                    -- 文件夹路径
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_path_cache_path ON path_cache(full_path);
CREATE INDEX IF NOT EXISTS idx_path_cache_folder ON path_cache(folder_path);

-- ============================================================================
-- 13. 知识导图元数据表
-- ============================================================================
CREATE TABLE IF NOT EXISTS mindmaps (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: mm_{nanoid(10)}
    resource_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_favorite INTEGER DEFAULT 0,
    default_view TEXT DEFAULT 'outline',          -- 'outline' | 'mindmap'
    theme TEXT,
    settings TEXT,                                -- JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
);

CREATE INDEX IF NOT EXISTS idx_mindmaps_deleted ON mindmaps(deleted_at);
CREATE INDEX IF NOT EXISTS idx_mindmaps_favorite ON mindmaps(is_favorite);
CREATE INDEX IF NOT EXISTS idx_mindmaps_resource ON mindmaps(resource_id);
CREATE INDEX IF NOT EXISTS idx_mindmaps_updated ON mindmaps(updated_at DESC);

-- ============================================================================
-- 14. 题目实体表
-- ============================================================================
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: q_{nanoid(10)}
    exam_id TEXT NOT NULL,                        -- 所属题目集
    card_id TEXT,                                 -- 原 preview card_id
    question_label TEXT,                          -- 题号标签
    content TEXT NOT NULL,                        -- 题干内容
    options_json TEXT,                            -- 选项 JSON（选择题）
    answer TEXT,                                  -- 标准答案
    explanation TEXT,                             -- 解析
    question_type TEXT DEFAULT 'other',           -- 题型
    difficulty TEXT,                              -- 难度
    tags TEXT DEFAULT '[]',                       -- 标签 JSON 数组
    status TEXT DEFAULT 'new',                    -- 学习状态
    user_answer TEXT,                             -- 用户最近答案
    is_correct INTEGER,                           -- 最近是否正确
    attempt_count INTEGER DEFAULT 0,              -- 尝试次数
    correct_count INTEGER DEFAULT 0,              -- 正确次数
    last_attempt_at TEXT,                         -- 最后答题时间
    user_note TEXT,                               -- 用户笔记
    is_favorite INTEGER DEFAULT 0,                -- 收藏标记
    is_bookmarked INTEGER DEFAULT 0,              -- 书签标记
    source_type TEXT DEFAULT 'ocr',               -- 来源类型
    source_ref TEXT,                              -- 来源引用
    parent_id TEXT,                               -- 父题 ID（变式题）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    -- 同步字段
    sync_status TEXT DEFAULT 'local_only',        -- 同步状态
    last_synced_at TEXT,                          -- 最后同步时间
    remote_id TEXT,                               -- 远程 ID
    content_hash TEXT,                            -- 内容哈希（冲突检测）
    remote_version INTEGER DEFAULT 0,             -- 远程版本号
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id),
    FOREIGN KEY (parent_id) REFERENCES questions(id)
);

CREATE INDEX IF NOT EXISTS idx_questions_exam_id ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);
CREATE INDEX IF NOT EXISTS idx_questions_card_id ON questions(card_id);
CREATE INDEX IF NOT EXISTS idx_questions_favorite ON questions(is_favorite);
CREATE INDEX IF NOT EXISTS idx_questions_bookmarked ON questions(is_bookmarked);
CREATE INDEX IF NOT EXISTS idx_questions_deleted ON questions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);
CREATE INDEX IF NOT EXISTS idx_questions_parent ON questions(parent_id);
CREATE INDEX IF NOT EXISTS idx_questions_exam_status ON questions(exam_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_exam_deleted ON questions(exam_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_questions_sync_status ON questions(sync_status);
CREATE INDEX IF NOT EXISTS idx_questions_remote_id ON questions(remote_id);
CREATE INDEX IF NOT EXISTS idx_questions_exam_sync ON questions(exam_id, sync_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_modified ON questions(exam_id, updated_at) WHERE sync_status = 'modified' AND deleted_at IS NULL;

-- ============================================================================
-- 15. 题目版本历史表
-- ============================================================================
CREATE TABLE IF NOT EXISTS question_history (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: qh_{nanoid(10)}
    question_id TEXT NOT NULL,
    field_name TEXT NOT NULL,                     -- 变更字段名
    old_value TEXT,
    new_value TEXT,
    operator TEXT DEFAULT 'user',                 -- user | system | ai
    reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE INDEX IF NOT EXISTS idx_question_history_question ON question_history(question_id);
CREATE INDEX IF NOT EXISTS idx_question_history_created ON question_history(created_at DESC);

-- ============================================================================
-- 16. 题目集统计缓存表
-- ============================================================================
CREATE TABLE IF NOT EXISTS question_bank_stats (
    exam_id TEXT PRIMARY KEY NOT NULL,
    total_count INTEGER DEFAULT 0,
    new_count INTEGER DEFAULT 0,
    in_progress_count INTEGER DEFAULT 0,
    mastered_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    total_attempts INTEGER DEFAULT 0,
    total_correct INTEGER DEFAULT 0,
    correct_rate REAL DEFAULT 0.0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
);

-- ============================================================================
-- 17. 题目全文检索 (FTS5)
-- ============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
    content,
    answer,
    explanation,
    tags,
    content='questions',
    content_rowid='rowid',
    tokenize='unicode61'
);

-- FTS 触发器
CREATE TRIGGER IF NOT EXISTS trg_questions_fts_insert
AFTER INSERT ON questions
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT INTO questions_fts(rowid, content, answer, explanation, tags)
    VALUES (NEW.rowid, NEW.content, COALESCE(NEW.answer, ''), COALESCE(NEW.explanation, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS trg_questions_fts_update
AFTER UPDATE ON questions
BEGIN
    DELETE FROM questions_fts WHERE rowid = OLD.rowid;
    INSERT INTO questions_fts(rowid, content, answer, explanation, tags)
    SELECT NEW.rowid, NEW.content, COALESCE(NEW.answer, ''), COALESCE(NEW.explanation, ''), COALESCE(NEW.tags, '[]')
    WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_questions_fts_delete
AFTER DELETE ON questions
BEGIN
    DELETE FROM questions_fts WHERE rowid = OLD.rowid;
END;

-- 题目 updated_at 自动更新触发器
CREATE TRIGGER IF NOT EXISTS trg_questions_updated_at
AFTER UPDATE ON questions
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE questions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- 18. 复习计划表 (SM-2 算法)
-- ============================================================================
CREATE TABLE IF NOT EXISTS review_plans (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: rp_{nanoid(10)}
    question_id TEXT NOT NULL UNIQUE,
    exam_id TEXT NOT NULL,
    ease_factor REAL NOT NULL DEFAULT 2.5,        -- 易度因子
    interval_days INTEGER NOT NULL DEFAULT 0,     -- 复习间隔（天）
    repetitions INTEGER NOT NULL DEFAULT 0,       -- 连续正确次数
    next_review_date TEXT NOT NULL,               -- 下次复习日期
    last_review_date TEXT,                        -- 上次复习日期
    status TEXT NOT NULL DEFAULT 'new',           -- new | learning | reviewing | graduated | suspended
    total_reviews INTEGER NOT NULL DEFAULT 0,
    total_correct INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    is_difficult INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
);

CREATE INDEX IF NOT EXISTS idx_review_plans_exam_id ON review_plans(exam_id);
CREATE INDEX IF NOT EXISTS idx_review_plans_next_review ON review_plans(next_review_date);
CREATE INDEX IF NOT EXISTS idx_review_plans_status ON review_plans(status);
CREATE INDEX IF NOT EXISTS idx_review_plans_difficult ON review_plans(is_difficult) WHERE is_difficult = 1;
CREATE INDEX IF NOT EXISTS idx_review_plans_exam_next_review ON review_plans(exam_id, next_review_date);
CREATE INDEX IF NOT EXISTS idx_review_plans_exam_status ON review_plans(exam_id, status);

-- 复习计划 updated_at 自动更新触发器
CREATE TRIGGER IF NOT EXISTS trg_review_plans_updated_at
AFTER UPDATE ON review_plans
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE review_plans SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- 19. 复习历史记录表
-- ============================================================================
CREATE TABLE IF NOT EXISTS review_history (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: rh_{nanoid(10)}
    plan_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    quality INTEGER NOT NULL CHECK (quality >= 0 AND quality <= 5),
    passed INTEGER NOT NULL,
    ease_factor_before REAL NOT NULL,
    ease_factor_after REAL NOT NULL,
    interval_before INTEGER NOT NULL,
    interval_after INTEGER NOT NULL,
    repetitions_before INTEGER NOT NULL,
    repetitions_after INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    user_answer TEXT,
    time_spent_seconds INTEGER,
    FOREIGN KEY (plan_id) REFERENCES review_plans(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_history_plan ON review_history(plan_id);
CREATE INDEX IF NOT EXISTS idx_review_history_question ON review_history(question_id);
CREATE INDEX IF NOT EXISTS idx_review_history_time ON review_history(reviewed_at DESC);

-- ============================================================================
-- 20. 复习统计缓存表
-- ============================================================================
CREATE TABLE IF NOT EXISTS review_stats (
    exam_id TEXT PRIMARY KEY,
    total_plans INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    learning_count INTEGER NOT NULL DEFAULT 0,
    reviewing_count INTEGER NOT NULL DEFAULT 0,
    graduated_count INTEGER NOT NULL DEFAULT 0,
    suspended_count INTEGER NOT NULL DEFAULT 0,
    due_today INTEGER NOT NULL DEFAULT 0,
    overdue_count INTEGER NOT NULL DEFAULT 0,
    difficult_count INTEGER NOT NULL DEFAULT 0,
    total_reviews INTEGER NOT NULL DEFAULT 0,
    total_correct INTEGER NOT NULL DEFAULT 0,
    avg_correct_rate REAL NOT NULL DEFAULT 0.0,
    avg_ease_factor REAL NOT NULL DEFAULT 2.5,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
);

-- ============================================================================
-- 21. 题目同步冲突表
-- ============================================================================
CREATE TABLE IF NOT EXISTS question_sync_conflicts (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: qsc_{nanoid(10)}
    question_id TEXT NOT NULL,
    exam_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,                  -- modify_modify | modify_delete | delete_modify | add_add
    local_snapshot TEXT NOT NULL,                 -- JSON
    remote_snapshot TEXT NOT NULL,                -- JSON
    local_hash TEXT,
    remote_hash TEXT,
    local_updated_at TEXT,
    remote_updated_at TEXT,
    status TEXT DEFAULT 'pending',                -- pending | resolved | skipped
    resolved_strategy TEXT,                       -- keep_local | keep_remote | keep_newer | merged | manual
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id),
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_exam_id ON question_sync_conflicts(exam_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_question_id ON question_sync_conflicts(question_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON question_sync_conflicts(status);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_exam_pending ON question_sync_conflicts(exam_id, status) WHERE status = 'pending';

-- ============================================================================
-- 22. 题目同步日志表
-- ============================================================================
CREATE TABLE IF NOT EXISTS question_sync_logs (
    id TEXT PRIMARY KEY NOT NULL,                 -- 格式: qsl_{nanoid(10)}
    exam_id TEXT NOT NULL,
    direction TEXT NOT NULL,                      -- push | pull
    sync_type TEXT DEFAULT 'incremental',         -- full | incremental
    result TEXT NOT NULL,                         -- success | partial | failed
    synced_count INTEGER DEFAULT 0,
    conflict_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    details_json TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_exam_id ON question_sync_logs(exam_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON question_sync_logs(started_at DESC);

-- ============================================================================
-- 23. 记忆系统配置表
-- ============================================================================
CREATE TABLE IF NOT EXISTS memory_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO memory_config (key, value, updated_at) VALUES
    ('memory_root_folder_id', '', datetime('now')),
    ('auto_create_subfolders', 'true', datetime('now')),
    ('default_category', '通用', datetime('now')),
    ('file_root_folder_id', '', datetime('now'));

-- ============================================================================
-- 24. 索引配置表
-- ============================================================================
CREATE TABLE IF NOT EXISTS vfs_indexing_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO vfs_indexing_config (key, value, updated_at) VALUES
    ('indexing.enabled', 'true', strftime('%s', 'now') * 1000),
    ('indexing.batch_size', '10', strftime('%s', 'now') * 1000),
    ('indexing.interval_secs', '5', strftime('%s', 'now') * 1000),
    ('indexing.max_concurrent', '2', strftime('%s', 'now') * 1000),
    ('indexing.retry_delay_secs', '60', strftime('%s', 'now') * 1000),
    ('indexing.max_retries', '3', strftime('%s', 'now') * 1000),
    ('chunking.strategy', 'fixed_size', strftime('%s', 'now') * 1000),
    ('chunking.chunk_size', '512', strftime('%s', 'now') * 1000),
    ('chunking.chunk_overlap', '50', strftime('%s', 'now') * 1000),
    ('chunking.min_chunk_size', '20', strftime('%s', 'now') * 1000),
    ('search.default_top_k', '10', strftime('%s', 'now') * 1000),
    ('search.enable_hybrid', 'true', strftime('%s', 'now') * 1000),
    ('search.enable_reranking', 'false', strftime('%s', 'now') * 1000),
    ('search.fts_weight', '0.3', strftime('%s', 'now') * 1000),
    ('search.vector_weight', '0.7', strftime('%s', 'now') * 1000);

-- ============================================================================
-- 25. 索引单元表（图片-文本组）
-- ============================================================================
CREATE TABLE IF NOT EXISTS vfs_index_units (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    unit_index INTEGER NOT NULL,
    image_blob_hash TEXT,
    image_mime_type TEXT,
    text_content TEXT,
    text_source TEXT,
    content_hash TEXT,
    text_required INTEGER NOT NULL DEFAULT 0,
    text_state TEXT NOT NULL DEFAULT 'disabled',  -- pending | indexing | indexed | failed | disabled
    text_error TEXT,
    text_indexed_at INTEGER,
    text_chunk_count INTEGER DEFAULT 0,
    text_embedding_dim INTEGER,
    mm_required INTEGER NOT NULL DEFAULT 0,
    mm_state TEXT NOT NULL DEFAULT 'disabled',    -- pending | indexing | indexed | failed | disabled
    mm_error TEXT,
    mm_indexed_at INTEGER,
    mm_embedding_dim INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vfs_index_units_unique ON vfs_index_units(resource_id, unit_index);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_resource ON vfs_index_units(resource_id);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_text_state ON vfs_index_units(text_state);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_mm_state ON vfs_index_units(mm_state);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_image_hash ON vfs_index_units(image_blob_hash);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_pending_text ON vfs_index_units(text_state, updated_at DESC) WHERE text_required = 1 AND text_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_pending_mm ON vfs_index_units(mm_state, updated_at DESC) WHERE mm_required = 1 AND mm_state = 'pending';

-- ============================================================================
-- 26. 索引段表（最小检索单位）
-- ============================================================================
CREATE TABLE IF NOT EXISTS vfs_index_segments (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    modality TEXT NOT NULL,                       -- text | image | multimodal
    embedding_dim INTEGER NOT NULL,
    lance_row_id TEXT NOT NULL,
    content_text TEXT,
    content_hash TEXT,
    start_pos INTEGER,
    end_pos INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vfs_index_segments_unique ON vfs_index_segments(unit_id, segment_index, modality, embedding_dim);
CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_unit ON vfs_index_segments(unit_id);
CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_modality_dim ON vfs_index_segments(modality, embedding_dim);
CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_lance ON vfs_index_segments(lance_row_id);

-- ============================================================================
-- 27. 向量维度注册表
-- ============================================================================
CREATE TABLE IF NOT EXISTS vfs_embedding_dims (
    dimension INTEGER NOT NULL,
    modality TEXT NOT NULL,
    lance_table_name TEXT NOT NULL,
    record_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    model_config_id TEXT,
    model_name TEXT,
    PRIMARY KEY (dimension, modality)
);

CREATE INDEX IF NOT EXISTS idx_vfs_embedding_dims_table ON vfs_embedding_dims(lance_table_name);
CREATE INDEX IF NOT EXISTS idx_vfs_embedding_dims_model ON vfs_embedding_dims(model_config_id);

-- ============================================================================
-- 视图：回收站统一视图
-- ============================================================================
CREATE VIEW IF NOT EXISTS trash_view AS
    SELECT
        'note' as item_type,
        id,
        title as name,
        deleted_at,
        updated_at
    FROM notes
    WHERE deleted_at IS NOT NULL

    UNION ALL

    SELECT
        'file' as item_type,
        id,
        COALESCE(name, file_name) as name,
        deleted_at,
        updated_at
    FROM files
    WHERE deleted_at IS NOT NULL

    UNION ALL

    SELECT
        'translation' as item_type,
        id,
        id as name,
        deleted_at,
        updated_at
    FROM translations
    WHERE deleted_at IS NOT NULL

    UNION ALL

    SELECT
        'exam' as item_type,
        id,
        exam_name as name,
        deleted_at,
        updated_at
    FROM exam_sheets
    WHERE deleted_at IS NOT NULL

    UNION ALL

    SELECT
        'essay' as item_type,
        id,
        title as name,
        deleted_at,
        updated_at
    FROM essays
    WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- 完成
-- ============================================================================
