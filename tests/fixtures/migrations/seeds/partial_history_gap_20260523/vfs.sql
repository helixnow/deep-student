-- Fixture seed: vfs @ schema V20260523, but the harness then DELETES the
-- V20260523 row from refinery_schema_history. This reproduces the classic
-- "DDL applied but history record rolled back" SQLite failure mode: the schema
-- already has the sync columns, yet refinery believes the migration is pending.
-- The production make_alter_columns_safe defense must pre-mark it as applied
-- instead of dying on "duplicate column".

INSERT INTO todo_lists (id, title, sort_order, is_default, created_at, updated_at)
VALUES ('tl_gap00000001', '五月计划', 0, 1, '2026-05-23T08:00:00.000Z', '2026-05-23T08:00:00.000Z');

INSERT INTO todo_items (id, todo_list_id, title, status, priority, tags_json, sort_order, created_at, updated_at)
VALUES ('ti_gap000000001', 'tl_gap00000001', '阶段复盘', 'pending', 'medium', '["复盘"]', 0,
        '2026-05-23T08:01:00.000Z', '2026-05-23T08:01:00.000Z');

INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration,
                              type, status, created_at, device_id, local_version, updated_at, deleted_at)
VALUES ('pd_gap000000001', 'ti_gap000000001', '2026-05-23T08:10:00.000Z', '2026-05-23T08:35:00.000Z',
        1500, 1500, 'work', 'completed', '2026-05-23T08:35:00.000Z', NULL, 0, NULL, NULL);
