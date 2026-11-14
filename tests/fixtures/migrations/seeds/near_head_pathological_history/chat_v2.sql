-- Fixture seed: chat_v2 @ schema V20260717 (one step before V20260719).
-- Same FTS trigger-gap corruption as the 2026-03 case, but at the near-HEAD epoch.
-- The fixture harness additionally corrupts the refinery history for this database
-- (malformed rows + checksum drift) and plants an orphan sessions_new table.

INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at)
VALUES ('sess_nh0000001', 'general_chat', '近期会话', 'active',
        '2026-07-20T10:00:00Z', '2026-07-20T10:30:00Z');

INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
VALUES
  ('msg_nh0000001', 'sess_nh0000001', 'user', '["blk_nh0000001"]', 1721469600000),
  ('msg_nh0000002', 'sess_nh0000001', 'assistant',
   '["blk_nh0000002","blk_nh0000003","blk_nh0000004"]', 1721469660000);

INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, tool_output_json)
VALUES
  ('blk_nh0000001', 'msg_nh0000001', 'content', 'success', 0, '总结这篇关于迁移测试的文档', NULL),
  ('blk_nh0000002', 'msg_nh0000002', 'thinking', 'success', 0, '先梳理文档结构，再提炼要点。', NULL),
  ('blk_nh0000003', 'msg_nh0000002', 'content', 'success', 1, '文档核心是历史夹具加生产升级校验。', NULL),
  ('blk_nh0000004', 'msg_nh0000002', 'mcp_tool', 'success', 2, NULL, '{"tool":"search","ok":true}');

-- Ghost index entry for the tool block.
INSERT INTO chat_v2_content_fts (rowid, content)
SELECT rowid, '幽灵工具输出' FROM chat_v2_blocks WHERE id = 'blk_nh0000004';

-- Missing index entry for a legit content block.
DELETE FROM chat_v2_content_fts
WHERE rowid = (SELECT rowid FROM chat_v2_blocks WHERE id = 'blk_nh0000003');
