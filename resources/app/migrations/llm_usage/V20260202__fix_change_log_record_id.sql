-- ============================================================================
-- V20260202: 修复 llm_usage_daily 变更日志 record_id 编码
-- ============================================================================
--
-- 旧实现使用 "date_caller_model_provider" 拼接字符串，存在歧义。
-- 改为 JSON 对象字符串，便于下载端可靠解码复合主键。

DROP TRIGGER IF EXISTS trg__change_log_usage_daily_insert;
DROP TRIGGER IF EXISTS trg__change_log_usage_daily_update;
DROP TRIGGER IF EXISTS trg__change_log_usage_daily_delete;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_insert
AFTER INSERT ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'llm_usage_daily',
        json_object(
            'date', NEW.date,
            'caller_type', NEW.caller_type,
            'model', NEW.model,
            'provider', NEW.provider
        ),
        'INSERT'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_update
AFTER UPDATE ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'llm_usage_daily',
        json_object(
            'date', NEW.date,
            'caller_type', NEW.caller_type,
            'model', NEW.model,
            'provider', NEW.provider
        ),
        'UPDATE'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_delete
AFTER DELETE ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'llm_usage_daily',
        json_object(
            'date', OLD.date,
            'caller_type', OLD.caller_type,
            'model', OLD.model,
            'provider', OLD.provider
        ),
        'DELETE'
    );
END;

