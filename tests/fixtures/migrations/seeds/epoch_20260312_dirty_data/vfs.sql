-- Fixture seed: vfs @ schema V20260312 (mid 2026-03 epoch: todo/pomodoro tables exist,
-- sync-coverage columns of V20260523 do NOT exist yet).
-- Dirty-data emphasis:
--   * note tags array mixing valid tags, a number, whitespace-only and duplicate entries
--     (V20260722 note_tags backfill must keep exactly the 2 valid distinct tags)
--   * resource with malformed metadata_json
--   * pomodoro rows without updated_at (column does not exist yet);
--     V20260523 adds it as NULL and V20260721 must backfill it from created_at

INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
VALUES
  ('res_dirty000001', 'fixture_hash_dirty_1', 'note', 'note_dirty0001', 'notes', 'inline',
   '待办与番茄钟联动测试笔记正文。', '{"unterminated', 1, 1710200000000, 1710200000000);

INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
VALUES
  ('note_dirty0001', 'res_dirty000001', '三月笔记', '["ok", 5, "  ", "dup", "dup"]', 0,
   '2026-03-12T08:00:00.000Z', '2026-03-12T08:00:00.000Z');

INSERT INTO todo_lists (id, title, description, sort_order, is_default, created_at, updated_at)
VALUES ('tl_dirty000001', '本周计划', '含子任务与番茄钟', 0, 1,
        '2026-03-12T08:00:00.000Z', '2026-03-12T08:00:00.000Z');

INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, tags_json,
                        sort_order, completed_at, created_at, updated_at)
VALUES
  ('ti_dirty0000001', 'tl_dirty000001', '复习错题', '第 3 章', 'pending', 'high', '["复习"]',
   0, NULL, '2026-03-12T08:01:00.000Z', '2026-03-12T08:01:00.000Z'),
  ('ti_dirty0000002', 'tl_dirty000001', '整理笔记', NULL, 'completed', 'none', '[]',
   1, '2026-03-12T09:00:00.000Z', '2026-03-12T08:02:00.000Z', '2026-03-12T09:00:00.000Z');

INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration, actual_duration,
                              type, status, created_at)
VALUES
  ('pd_dirty0000001', 'ti_dirty0000001', '2026-03-12T08:10:00.000Z', '2026-03-12T08:35:00.000Z',
   1500, 1500, 'work', 'completed', '2026-03-12T08:35:00.000Z'),
  ('pd_dirty0000002', NULL, '2026-03-12T08:40:00.000Z', NULL,
   1500, 600, 'work', 'interrupted', '2026-03-12T08:50:00.000Z');
