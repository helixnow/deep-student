-- ============================================================================
-- V20260524: 为 __change_log 增加字段增量元数据，并让资源计数触发器写入 delta
-- ============================================================================

ALTER TABLE __change_log ADD COLUMN field_deltas_json TEXT;

DROP TRIGGER IF EXISTS trg__change_log_resources_insert;
DROP TRIGGER IF EXISTS trg__change_log_resources_update;
DROP TRIGGER IF EXISTS trg__change_log_resources_delete;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_insert
AFTER INSERT ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, field_deltas_json)
    VALUES (
        'resources',
        NEW.id,
        'INSERT',
        CASE
            WHEN NEW.ref_count IS NOT NULL THEN json_object('ref_count', NEW.ref_count)
            ELSE NULL
        END
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_update
AFTER UPDATE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, field_deltas_json)
    VALUES (
        'resources',
        NEW.id,
        'UPDATE',
        CASE
            WHEN NEW.ref_count IS NOT NULL
             AND OLD.ref_count IS NOT NULL
             AND NEW.ref_count != OLD.ref_count
            THEN json_object('ref_count', NEW.ref_count - OLD.ref_count)
            ELSE NULL
        END
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_delete
AFTER DELETE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', OLD.id, 'DELETE');
END;
