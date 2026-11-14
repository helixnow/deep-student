-- ============================================================================
-- V20260523: 为剩余 VFS 表添加云同步字段和变更日志触发器
-- ============================================================================
--
-- 此迁移为 VFS 数据库中尚未配备同步设施的表补充：
-- - device_id / local_version 字段
-- - updated_at / deleted_at 字段（仅为缺少的表添加）
-- - __change_log 触发器（INSERT / UPDATE / DELETE）
-- - 增量同步复合索引与部分索引
--
-- 已在前续迁移中覆盖的表（无需重复处理）：
--   resources, notes, questions, review_plans, folders
--
-- 目标表：files, translations, essays, essay_sessions, mindmaps,
--         folder_items, answer_submissions, todo_lists, todo_items,
--         pomodoro_records
-- ============================================================================

-- ============================================================================
-- 1. files 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE files ADD COLUMN device_id TEXT;
ALTER TABLE files ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_files_local_version ON files(local_version);
CREATE INDEX IF NOT EXISTS idx_files_device_id ON files(device_id);
CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(updated_at);

-- ============================================================================
-- 2. translations 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE translations ADD COLUMN device_id TEXT;
ALTER TABLE translations ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_translations_local_version ON translations(local_version);
CREATE INDEX IF NOT EXISTS idx_translations_device_id ON translations(device_id);
CREATE INDEX IF NOT EXISTS idx_translations_updated_at ON translations(updated_at);

-- ============================================================================
-- 3. essays 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE essays ADD COLUMN device_id TEXT;
ALTER TABLE essays ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_essays_local_version ON essays(local_version);
CREATE INDEX IF NOT EXISTS idx_essays_device_id ON essays(device_id);
CREATE INDEX IF NOT EXISTS idx_essays_updated_at ON essays(updated_at);

-- ============================================================================
-- 4. essay_sessions 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE essay_sessions ADD COLUMN device_id TEXT;
ALTER TABLE essay_sessions ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_essay_sessions_local_version ON essay_sessions(local_version);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_device_id ON essay_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_updated_at ON essay_sessions(updated_at);

-- ============================================================================
-- 5. mindmaps 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE mindmaps ADD COLUMN device_id TEXT;
ALTER TABLE mindmaps ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_mindmaps_local_version ON mindmaps(local_version);
CREATE INDEX IF NOT EXISTS idx_mindmaps_device_id ON mindmaps(device_id);

-- mindmaps 的 updated_at 索引（在 init 中已有 idx_mindmaps_updated，补充 sync 索引）
CREATE INDEX IF NOT EXISTS idx_mindmaps_updated_at ON mindmaps(updated_at);

-- ============================================================================
-- 6. folder_items 表 (已有 updated_at INTEGER, deleted_at TEXT)
-- ============================================================================

ALTER TABLE folder_items ADD COLUMN device_id TEXT;
ALTER TABLE folder_items ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_folder_items_local_version ON folder_items(local_version);
CREATE INDEX IF NOT EXISTS idx_folder_items_device_id ON folder_items(device_id);
CREATE INDEX IF NOT EXISTS idx_folder_items_updated_at ON folder_items(updated_at);

-- 唯一约束：同一文件夹内相同类型+ID 的未删除项唯一
-- 先删除 init 中创建的非部分（non-partial）唯一索引，改为部分索引以支持软删除
DROP INDEX IF EXISTS idx_folder_items_unique_v2;
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_items_unique
    ON folder_items(folder_id, item_type, item_id) WHERE deleted_at IS NULL;

-- ============================================================================
-- 7. answer_submissions 表 (无 updated_at, deleted_at, device_id, local_version)
-- ============================================================================

ALTER TABLE answer_submissions ADD COLUMN device_id TEXT;
ALTER TABLE answer_submissions ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE answer_submissions ADD COLUMN updated_at TEXT;
ALTER TABLE answer_submissions ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_answer_submissions_local_version ON answer_submissions(local_version);
CREATE INDEX IF NOT EXISTS idx_answer_submissions_device_id ON answer_submissions(device_id);
CREATE INDEX IF NOT EXISTS idx_answer_submissions_updated_at ON answer_submissions(updated_at);

-- ============================================================================
-- 8. todo_lists 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE todo_lists ADD COLUMN device_id TEXT;
ALTER TABLE todo_lists ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_todo_lists_local_version ON todo_lists(local_version);
CREATE INDEX IF NOT EXISTS idx_todo_lists_device_id ON todo_lists(device_id);
CREATE INDEX IF NOT EXISTS idx_todo_lists_updated_not_deleted ON todo_lists(updated_at) WHERE deleted_at IS NULL;

-- ============================================================================
-- 9. todo_items 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE todo_items ADD COLUMN device_id TEXT;
ALTER TABLE todo_items ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_todo_items_local_version ON todo_items(local_version);
CREATE INDEX IF NOT EXISTS idx_todo_items_device_id ON todo_items(device_id);
CREATE INDEX IF NOT EXISTS idx_todo_items_updated_not_deleted ON todo_items(updated_at) WHERE deleted_at IS NULL;

-- ============================================================================
-- 10. pomodoro_records 表 (无 updated_at, deleted_at, device_id, local_version)
-- ============================================================================

ALTER TABLE pomodoro_records ADD COLUMN device_id TEXT;
ALTER TABLE pomodoro_records ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE pomodoro_records ADD COLUMN updated_at TEXT;
ALTER TABLE pomodoro_records ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_pomodoro_records_local_version ON pomodoro_records(local_version);
CREATE INDEX IF NOT EXISTS idx_pomodoro_records_device_id ON pomodoro_records(device_id);
CREATE INDEX IF NOT EXISTS idx_pomodoro_records_updated_at ON pomodoro_records(updated_at);

-- ============================================================================
-- 变更日志触发器
-- ============================================================================

-- files 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_files_insert
AFTER INSERT ON files
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('files', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_files_update
AFTER UPDATE ON files
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('files', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_files_delete
AFTER DELETE ON files
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('files', OLD.id, 'DELETE');
END;

-- translations 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_translations_insert
AFTER INSERT ON translations
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('translations', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_translations_update
AFTER UPDATE ON translations
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('translations', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_translations_delete
AFTER DELETE ON translations
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('translations', OLD.id, 'DELETE');
END;

-- essays 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_essays_insert
AFTER INSERT ON essays
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essays', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_essays_update
AFTER UPDATE ON essays
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essays', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_essays_delete
AFTER DELETE ON essays
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essays', OLD.id, 'DELETE');
END;

-- essay_sessions 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_essay_sessions_insert
AFTER INSERT ON essay_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essay_sessions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_essay_sessions_update
AFTER UPDATE ON essay_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essay_sessions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_essay_sessions_delete
AFTER DELETE ON essay_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('essay_sessions', OLD.id, 'DELETE');
END;

-- mindmaps 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_mindmaps_insert
AFTER INSERT ON mindmaps
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mindmaps', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mindmaps_update
AFTER UPDATE ON mindmaps
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mindmaps', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mindmaps_delete
AFTER DELETE ON mindmaps
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mindmaps', OLD.id, 'DELETE');
END;

-- folder_items 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_folder_items_insert
AFTER INSERT ON folder_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folder_items', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_folder_items_update
AFTER UPDATE ON folder_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folder_items', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_folder_items_delete
AFTER DELETE ON folder_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folder_items', OLD.id, 'DELETE');
END;

-- answer_submissions 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_answer_submissions_insert
AFTER INSERT ON answer_submissions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('answer_submissions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_answer_submissions_update
AFTER UPDATE ON answer_submissions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('answer_submissions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_answer_submissions_delete
AFTER DELETE ON answer_submissions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('answer_submissions', OLD.id, 'DELETE');
END;

-- todo_lists 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_lists_insert
AFTER INSERT ON todo_lists
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_lists', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_lists_update
AFTER UPDATE ON todo_lists
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_lists', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_lists_delete
AFTER DELETE ON todo_lists
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_lists', OLD.id, 'DELETE');
END;

-- todo_items 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_items_insert
AFTER INSERT ON todo_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_items', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_items_update
AFTER UPDATE ON todo_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_items', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_todo_items_delete
AFTER DELETE ON todo_items
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('todo_items', OLD.id, 'DELETE');
END;

-- pomodoro_records 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_pomodoro_records_insert
AFTER INSERT ON pomodoro_records
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('pomodoro_records', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_pomodoro_records_update
AFTER UPDATE ON pomodoro_records
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('pomodoro_records', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_pomodoro_records_delete
AFTER DELETE ON pomodoro_records
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('pomodoro_records', OLD.id, 'DELETE');
END;

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_files_device_version ON files(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_translations_device_version ON translations(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_essays_device_version ON essays(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_essay_sessions_device_version ON essay_sessions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_mindmaps_device_version ON mindmaps(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_folder_items_device_version ON folder_items(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_answer_submissions_device_version ON answer_submissions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_todo_lists_device_version ON todo_lists(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_todo_items_device_version ON todo_items(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_pomodoro_records_device_version ON pomodoro_records(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_files_updated_not_deleted ON files(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_translations_updated_not_deleted ON translations(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_essays_updated_not_deleted ON essays(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_essay_sessions_updated_not_deleted ON essay_sessions(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mindmaps_updated_not_deleted ON mindmaps(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_folder_items_updated_not_deleted ON folder_items(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_answer_submissions_updated_not_deleted ON answer_submissions(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_todo_lists_updated_not_deleted ON todo_lists(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_todo_items_updated_not_deleted ON todo_items(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pomodoro_records_updated_not_deleted ON pomodoro_records(updated_at) WHERE deleted_at IS NULL;

-- ============================================================================
-- 11. exam_sheets 表 (已有 updated_at TEXT, deleted_at TEXT，缺 device_id/local_version/change_log)
-- ============================================================================

ALTER TABLE exam_sheets ADD COLUMN device_id TEXT;
ALTER TABLE exam_sheets ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_exam_sheets_local_version ON exam_sheets(local_version);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_device_id ON exam_sheets(device_id);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_updated_at ON exam_sheets(updated_at);

-- exam_sheets 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_exam_sheets_insert
AFTER INSERT ON exam_sheets
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('exam_sheets', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_exam_sheets_update
AFTER UPDATE ON exam_sheets
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('exam_sheets', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_exam_sheets_delete
AFTER DELETE ON exam_sheets
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('exam_sheets', OLD.id, 'DELETE');
END;

-- ============================================================================
-- 复合索引：支持 exam_sheets 增量同步查询
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_exam_sheets_device_version ON exam_sheets(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_exam_sheets_updated_not_deleted ON exam_sheets(updated_at) WHERE deleted_at IS NULL;

-- ============================================================================
-- 补充 files.sha256 唯一约束索引（init 中已创建，确保存在）
-- ============================================================================
