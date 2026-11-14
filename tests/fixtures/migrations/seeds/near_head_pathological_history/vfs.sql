-- Fixture seed: vfs @ schema V20260720 (one step before the newest migrations).
-- Exercises the newest migrations against realistic data:
--   * pomodoro rows with NULL updated_at (V20260721 backfill) plus one row whose
--     updated_at is already set and must NOT be overwritten
--   * notes + resources for the new notes_fts (V20260721) and note_tags (V20260722)

INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
VALUES
  ('res_nh00000001', 'fixture_hash_nh_1', 'note', 'note_nh0000001', 'notes', 'inline',
   '量子比特与纠缠是量子计算的基础。', '{"words":14}', 1, 1721440000000, 1721440000000);

INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
VALUES
  ('note_nh0000001', 'res_nh00000001', '量子计算简介', '["量子","physics"]', 0,
   '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z');

INSERT INTO todo_lists (id, title, sort_order, is_default, created_at, updated_at)
VALUES ('tl_nh00000001', '七月计划', 0, 1, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z');

INSERT INTO todo_items (id, todo_list_id, title, status, priority, tags_json, sort_order, created_at, updated_at)
VALUES ('ti_nh000000001', 'tl_nh00000001', '准备考试', 'pending', 'urgent', '[]', 0,
        '2026-07-20T08:01:00.000Z', '2026-07-20T08:01:00.000Z');

INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration,
                              type, status, created_at, device_id, local_version, updated_at, deleted_at)
VALUES
  ('pd_nh0000000001', 'ti_nh000000001', '2026-07-20T08:10:00.000Z', '2026-07-20T08:35:00.000Z',
   1500, 1500, 'work', 'completed', '2026-07-20T08:35:00.000Z', NULL, 0, NULL, NULL),
  ('pd_nh0000000002', NULL, '2026-07-20T08:40:00.000Z', NULL,
   300, 300, 'short_break', 'completed', '2026-07-20T08:45:00.000Z', NULL, 0, NULL, NULL),
  ('pd_nh0000000003', NULL, '2026-07-20T09:00:00.000Z', '2026-07-20T09:25:00.000Z',
   1500, 1400, 'work', 'completed', '2026-07-20T09:25:00.000Z', 'device_a', 3,
   '2026-07-20T09:30:00.000Z', NULL);
