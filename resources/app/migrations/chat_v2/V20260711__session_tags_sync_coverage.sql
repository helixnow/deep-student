-- ============================================================================
-- V20260711: 为会话标签补齐行级同步变更日志
-- ============================================================================
--
-- chat_v2_session_tags 使用 (session_id, tag) 复合主键。record_id 必须使用
-- JSON 对象编码，避免冒号拼接在键本身包含冒号时产生歧义。
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_tags_insert
AFTER INSERT ON chat_v2_session_tags
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'chat_v2_session_tags',
        json_object('session_id', NEW.session_id, 'tag', NEW.tag),
        'INSERT'
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_tags_update
AFTER UPDATE ON chat_v2_session_tags
BEGIN
    -- A primary-key change is a delete plus an insert for peers that still hold
    -- the old key. Normal tag_type updates remain a single UPDATE operation.
    INSERT INTO __change_log (table_name, record_id, operation)
    SELECT
        'chat_v2_session_tags',
        json_object('session_id', OLD.session_id, 'tag', OLD.tag),
        'DELETE'
    WHERE OLD.session_id IS NOT NEW.session_id OR OLD.tag IS NOT NEW.tag;

    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'chat_v2_session_tags',
        json_object('session_id', NEW.session_id, 'tag', NEW.tag),
        CASE
            WHEN OLD.session_id IS NEW.session_id AND OLD.tag IS NEW.tag THEN 'UPDATE'
            ELSE 'INSERT'
        END
    );
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_tags_delete
AFTER DELETE ON chat_v2_session_tags
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES (
        'chat_v2_session_tags',
        json_object('session_id', OLD.session_id, 'tag', OLD.tag),
        'DELETE'
    );
END;
