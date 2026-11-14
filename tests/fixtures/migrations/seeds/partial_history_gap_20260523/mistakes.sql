-- Fixture seed: mistakes @ schema V20260714 (automation scheduler just landed).

INSERT INTO automation_definitions (id, name, schedule_json, prompt, enabled,
                                    created_at, updated_at, source_session_id)
VALUES ('auto_gap0000001', '周报生成', '{"kind":"weekly","weekday":5}', '生成本周学习周报', 0,
        '2026-05-23T12:00:00Z', '2026-05-23T12:00:00Z', '');
