-- Fixture seed: chat_v2 @ schema V20260130 (oldest consolidated epoch)
-- Simulates a pre-refinery chat database:
--   * one active session with user/assistant messages and thinking/content blocks
--   * one legacy-trash session with persist_status='deleted'
--     (V20260502 must reinterpret it as 'archived' instead of destroying it)
--   * one block with malformed tool_output_json
-- The fixture harness additionally drops refinery_schema_history and installs
-- the legacy chat_v2_migrations marker table (ensure_legacy_baseline path).

INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at, metadata_json)
VALUES
  ('sess_legacy0001', 'general_chat', '旧版会话', 'active',
   '2026-01-30T10:00:00Z', '2026-01-30T10:30:00Z', '{"pinned":true}'),
  ('sess_legacy0002', 'analysis', '已删除的旧会话', 'deleted',
   '2026-01-29T10:00:00Z', '2026-01-29T11:00:00Z', NULL);

INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
VALUES
  ('msg_legacy0001', 'sess_legacy0001', 'user', '["blk_legacy0001"]', 1706608800000),
  ('msg_legacy0002', 'sess_legacy0001', 'assistant', '["blk_legacy0002","blk_legacy0003"]', 1706608860000);

INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, tool_output_json)
VALUES
  ('blk_legacy0001', 'msg_legacy0001', 'content', 'success', 0, '请解释神经网络的反向传播', NULL),
  ('blk_legacy0002', 'msg_legacy0002', 'thinking', 'success', 0, '先回忆链式法则，再展开梯度……', NULL),
  ('blk_legacy0003', 'msg_legacy0002', 'content', 'success', 1, '反向传播通过链式法则逐层计算梯度。', '{not valid json');
