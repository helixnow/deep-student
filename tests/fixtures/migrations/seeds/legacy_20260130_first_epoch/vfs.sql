-- Fixture seed: vfs @ schema V20260130 (oldest consolidated epoch)
-- Simulates a real early-2026 user database:
--   * notes with CJK + emoji titles, one with malformed tags JSON
--   * a notes_versions row (table is dropped later by V20260214 -> data-destructive path)
--   * exam sheet + questions (FTS triggers fire), one question with malformed tags
--   * a resource with malformed metadata_json

INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
VALUES
  ('res_note0000001', 'fixture_hash_note_1', 'note', 'note_legacy001', 'notes', 'inline',
   '# 深度学习笔记' || char(10) || '梯度下降与反向传播的推导过程。', '{"words":12}', 1, 1706600000000, 1706600000000),
  ('res_note0000002', 'fixture_hash_note_2', 'note', 'note_legacy002', 'notes', 'inline',
   'Second legacy note body with plain ASCII content.', NULL, 1, 1706600001000, 1706600001000),
  ('res_exam0000001', 'fixture_hash_exam_1', 'exam', NULL, NULL, 'inline',
   '{"pages":[]}', '{"unterminated json', 0, 1706600002000, 1706600002000);

INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
VALUES
  ('note_legacy001', 'res_note0000001', '深度学习笔记 📚', '["ml","深度学习"]', 1,
   '2026-01-30T08:00:00.000Z', '2026-01-30T08:00:00.000Z'),
  ('note_legacy002', 'res_note0000002', 'Legacy plain note', '{broken json', 0,
   '2026-01-30T08:05:00.000Z', '2026-01-30T08:05:00.000Z');

INSERT INTO notes_versions (version_id, note_id, resource_id, title, tags, created_at)
VALUES
  ('ver_legacy00001', 'note_legacy001', 'res_note0000001', '深度学习笔记 📚', '["ml"]',
   '2026-01-30T08:01:00.000Z');

INSERT INTO folders (id, parent_id, title, created_at, updated_at)
VALUES ('fld_legacy0001', NULL, '学习资料夹', 1706600000000, 1706600000000);

INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
VALUES ('exam_legacy001', 'res_exam0000001', '期中试卷', 'completed', 'temp_legacy_1', '{}', '{}',
        '2026-01-30T09:00:00.000Z', '2026-01-30T09:00:00.000Z');

INSERT INTO questions (id, exam_id, content, options_json, answer, tags, created_at, updated_at)
VALUES
  ('q_legacy000001', 'exam_legacy001', '计算 1+1 的值', '["1","2","3","4"]', '2', '["算术"]',
   '2026-01-30T09:01:00.000Z', '2026-01-30T09:01:00.000Z'),
  ('q_legacy000002', 'exam_legacy001', '什么是反向传播？', NULL, NULL, '{oops',
   '2026-01-30T09:02:00.000Z', '2026-01-30T09:02:00.000Z');
