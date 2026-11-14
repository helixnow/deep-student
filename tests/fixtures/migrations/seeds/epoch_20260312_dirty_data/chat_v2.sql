-- Fixture seed: chat_v2 @ schema V20260302 (content FTS of V20260301 exists).
-- Reproduces the historical FTS trigger-gap corruption that V20260719 must repair:
--   * a 'rag' block manually injected into chat_v2_content_fts (ghost index entry)
--   * a 'content' block whose FTS row is deleted (missing index entry)
-- After upgrade, chat_v2_content_fts must contain exactly the non-empty
-- content/thinking blocks.

INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at)
VALUES ('sess_dirty0001', 'general_chat', '三月会话', 'active',
        '2026-03-12T10:00:00Z', '2026-03-12T10:30:00Z');

INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
VALUES
  ('msg_dirty0001', 'sess_dirty0001', 'user', '["blk_dirty0001"]', 1710237600000),
  ('msg_dirty0002', 'sess_dirty0001', 'assistant',
   '["blk_dirty0002","blk_dirty0003","blk_dirty0004"]', 1710237660000);

-- Insert triggers index the content/thinking blocks automatically.
INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, tool_output_json)
VALUES
  ('blk_dirty0001', 'msg_dirty0001', 'content', 'success', 0, '机器学习入门问题', NULL),
  ('blk_dirty0002', 'msg_dirty0002', 'thinking', 'success', 0, '思考中：监督学习与无监督学习', NULL),
  ('blk_dirty0003', 'msg_dirty0002', 'content', 'success', 1, '机器学习分为监督、无监督与强化学习。', NULL),
  ('blk_dirty0004', 'msg_dirty0002', 'rag', 'success', 2, NULL, '{"hits":[]}');

-- Ghost index entry: rag block leaked into FTS (historical trigger gap).
INSERT INTO chat_v2_content_fts (rowid, content)
SELECT rowid, '幽灵索引内容' FROM chat_v2_blocks WHERE id = 'blk_dirty0004';

-- Missing index entry: content block dropped out of FTS (historical trigger gap).
DELETE FROM chat_v2_content_fts
WHERE rowid = (SELECT rowid FROM chat_v2_blocks WHERE id = 'blk_dirty0003');
