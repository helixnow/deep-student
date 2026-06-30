-- ============================================================================
-- V20260613: 番茄钟时间戳基准修复 + 记录枚举约束（审阅问题 S2 / M7）
-- ============================================================================
--
-- 1. 历史 bug：pomodoro_repo 曾用本地时间（无 Z 后缀）写入
--    pomodoro_records.created_at 以及关联任务的 todo_items.updated_at，
--    与其余路径的 UTC+Z 格式混用。todo_items/todo_lists/pomodoro_records
--    均参与云同步（LWW / FieldMerge 依赖 updated_at 字符串比较），
--    时间基准错位最大可达一个时区偏移量，导致同步冲突误判。
--    此处用 SQLite 的 'utc' 修饰符把"本地裸时间戳"换算为 UTC 并补 Z。
--    （依赖执行迁移时的系统时区与写入时一致——单机数据成立。）
--
-- 2. pomodoro_records 此前没有任何枚举/数值约束（对比 todo_items 的触发器），
--    本迁移补齐 INSERT 校验触发器。
-- ============================================================================

-- ============================================================================
-- 1. 修复存量裸时间戳（无 Z 后缀 → 视为本地时间转 UTC）
-- ============================================================================
UPDATE pomodoro_records
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'utc')
WHERE created_at IS NOT NULL
  AND created_at NOT LIKE '%Z'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'utc') IS NOT NULL;

UPDATE todo_items
SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, 'utc')
WHERE updated_at IS NOT NULL
  AND updated_at NOT LIKE '%Z'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, 'utc') IS NOT NULL;

-- ============================================================================
-- 2. pomodoro_records 枚举/数值校验触发器
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_pomodoro_records_validate_insert
BEFORE INSERT ON pomodoro_records
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'pomodoro_records.type is invalid')
    WHERE NEW.type NOT IN ('work', 'short_break', 'long_break');

    SELECT RAISE(ABORT, 'pomodoro_records.status is invalid')
    WHERE NEW.status NOT IN ('completed', 'interrupted');

    SELECT RAISE(ABORT, 'pomodoro_records.duration must be >= 0')
    WHERE NEW.duration < 0;

    SELECT RAISE(ABORT, 'pomodoro_records.actual_duration must be >= 0')
    WHERE NEW.actual_duration < 0;
END;
