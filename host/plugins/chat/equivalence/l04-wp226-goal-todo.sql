-- Seed l04-wp226-goal-todo (pending owner X3: seed directory mechanism).
-- Apply to chat_v2.db of a data directory that the app has already started once
-- (schema: src-tauri/migrations/chat_v2/V20260130__init.sql:25-38,50-66,81-100,220-232,
-- V20260905__goal_table.sql:22-33; later ALTER columns all have defaults), app stopped.
-- No frontend-reachable IPC command creates these rows:
--   chat_v2_goals      only via the model tool goal_update (tools/goal_executor.rs:209).
--   chat_v2_todo_lists only via the model todo tool (tools/todo_executor.rs).
-- Used by goals-todos.seeded.json.

-- ---------------------------------------------------------------------------
-- Goal sessions: one goal per status, plus an editable one and an orphan goal.
-- ---------------------------------------------------------------------------
INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at, metadata_json) VALUES
('sess_wp226_goal_active',   'chat', '目标-active',         'active', '2026-11-01T08:00:00Z', '2026-11-01T08:00:00Z', NULL),
('sess_wp226_goal_waiting',  'chat', '目标-waiting_user',   'active', '2026-11-01T08:00:01Z', '2026-11-01T08:00:01Z', NULL),
('sess_wp226_goal_blocked',  'chat', '目标-blocked',        'active', '2026-11-01T08:00:02Z', '2026-11-01T08:00:02Z', NULL),
('sess_wp226_goal_budget',   'chat', '目标-budget_limited', 'active', '2026-11-01T08:00:03Z', '2026-11-01T08:00:03Z', NULL),
('sess_wp226_goal_usage',    'chat', '目标-usage_limited',  'active', '2026-11-01T08:00:04Z', '2026-11-01T08:00:04Z', NULL),
('sess_wp226_goal_complete', 'chat', '目标-complete',       'active', '2026-11-01T08:00:05Z', '2026-11-01T08:00:05Z', NULL),
('sess_wp226_goal_paused',   'chat', '目标-paused',         'active', '2026-11-01T08:00:06Z', '2026-11-01T08:00:06Z', NULL),
('sess_wp226_goal_edit',     'chat', '目标-可编辑',          'active', '2026-11-01T08:00:07Z', '2026-11-01T08:00:07Z', '{"note":"保留"}');

INSERT INTO chat_v2_goals (session_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, continuation_count, created_at_ms, updated_at_ms) VALUES
('sess_wp226_goal_active',   'goal_wp226_active',   '掌握第一章',     'active',         NULL,  120, 30, 1, 1762000000000, 1762000001000),
('sess_wp226_goal_waiting',  'goal_wp226_waiting',  '等待学生作答',   'waiting_user',   2000,  300, 45, 2, 1762000000000, 1762000002000),
('sess_wp226_goal_blocked',  'goal_wp226_blocked',  '缺少教材',       'blocked',        NULL,  50,  10, 3, 1762000000000, 1762000003000),
('sess_wp226_goal_budget',   'goal_wp226_budget',   '预算耗尽',       'budget_limited', 1000,  1000, 99, 4, 1762000000000, 1762000004000),
('sess_wp226_goal_usage',    'goal_wp226_usage',    '用量受限',       'usage_limited',  NULL,  0,   0,  0, 1762000000000, 1762000005000),
('sess_wp226_goal_complete', 'goal_wp226_complete', '已完成的目标',   'complete',       500,   480, 60, 5, 1762000000000, 1762000006000),
('sess_wp226_goal_paused',   'goal_wp226_paused',   '暂停中的目标',   'paused',         NULL,  10,  1,  0, 1762000000000, 1762000007000),
('sess_wp226_goal_edit',     'goal_wp226_edit',     '旧目标描述',     'active',         3000,  0,   0,  0, 1762000000000, 1762000008000),
-- chat_v2_goals has no FK: a goal row whose session row does not exist.
('sess_wp226_goal_orphan',   'goal_wp226_orphan',   '孤立目标',       'active',         NULL,  0,   0,  0, 1762000000000, 1762000009000);

-- ---------------------------------------------------------------------------
-- TodoList sessions: each has a user + assistant message; the todo row points
-- at the assistant message.
--   open      is_all_done=0, pending/running steps        -> continue succeeds
--   open2     is_all_done=0, pending steps                -> continue with mismatched messageId (warn only)
--   alldone   is_all_done=0, all steps completed/failed/skipped -> "TODO list is already complete"
--   flagged   is_all_done=1                               -> "No incomplete TODO list found"
--   badjson   is_all_done=0, steps_json not a step array  -> "Failed to deserialize steps"
-- ---------------------------------------------------------------------------
INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at, metadata_json) VALUES
('sess_wp226_todo_open',    'chat', '任务-open',    'active', '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z', NULL),
('sess_wp226_todo_open2',   'chat', '任务-open2',   'active', '2026-11-01T09:00:01Z', '2026-11-01T09:00:01Z', NULL),
('sess_wp226_todo_alldone', 'chat', '任务-alldone', 'active', '2026-11-01T09:00:02Z', '2026-11-01T09:00:02Z', NULL),
('sess_wp226_todo_flagged', 'chat', '任务-flagged', 'active', '2026-11-01T09:00:03Z', '2026-11-01T09:00:03Z', NULL),
('sess_wp226_todo_badjson', 'chat', '任务-badjson', 'active', '2026-11-01T09:00:04Z', '2026-11-01T09:00:04Z', NULL);

INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) VALUES
('msg_wp226_todo_open_u',    'sess_wp226_todo_open',    'user',      '["blk_wp226_todo_open_u"]',    1762003600000),
('msg_wp226_todo_open',      'sess_wp226_todo_open',    'assistant', '["blk_wp226_todo_open_a"]',    1762003601000),
('msg_wp226_todo_open2_u',   'sess_wp226_todo_open2',   'user',      '["blk_wp226_todo_open2_u"]',   1762003602000),
('msg_wp226_todo_open2',     'sess_wp226_todo_open2',   'assistant', '["blk_wp226_todo_open2_a"]',   1762003603000),
('msg_wp226_todo_alldone_u', 'sess_wp226_todo_alldone', 'user',      '["blk_wp226_todo_alldone_u"]', 1762003604000),
('msg_wp226_todo_alldone',   'sess_wp226_todo_alldone', 'assistant', '["blk_wp226_todo_alldone_a"]', 1762003605000),
('msg_wp226_todo_flagged_u', 'sess_wp226_todo_flagged', 'user',      '["blk_wp226_todo_flagged_u"]', 1762003606000),
('msg_wp226_todo_flagged',   'sess_wp226_todo_flagged', 'assistant', '["blk_wp226_todo_flagged_a"]', 1762003607000),
('msg_wp226_todo_badjson_u', 'sess_wp226_todo_badjson', 'user',      '["blk_wp226_todo_badjson_u"]', 1762003608000),
('msg_wp226_todo_badjson',   'sess_wp226_todo_badjson', 'assistant', '["blk_wp226_todo_badjson_a"]', 1762003609000);

INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, started_at, ended_at) VALUES
('blk_wp226_todo_open_u',     'msg_wp226_todo_open_u',    'content', 'success', 0, '帮我分三步复习第二章', 1762003600000, 1762003600000),
('blk_wp226_todo_open_a',     'msg_wp226_todo_open',      'content', 'success', 0, '已列出计划，先做第一步。',   1762003601000, 1762003601500),
('blk_wp226_todo_open2_u',    'msg_wp226_todo_open2_u',   'content', 'success', 0, '整理错题',               1762003602000, 1762003602000),
('blk_wp226_todo_open2_a',    'msg_wp226_todo_open2',     'content', 'success', 0, '计划已建立。',           1762003603000, 1762003603500),
('blk_wp226_todo_alldone_u',  'msg_wp226_todo_alldone_u', 'content', 'success', 0, '做完了吗',               1762003604000, 1762003604000),
('blk_wp226_todo_alldone_a',  'msg_wp226_todo_alldone',   'content', 'success', 0, '全部步骤已结束。',       1762003605000, 1762003605500),
('blk_wp226_todo_flagged_u',  'msg_wp226_todo_flagged_u', 'content', 'success', 0, '旧任务',                 1762003606000, 1762003606000),
('blk_wp226_todo_flagged_a',  'msg_wp226_todo_flagged',   'content', 'success', 0, '旧任务已完成。',         1762003607000, 1762003607500),
('blk_wp226_todo_badjson_u',  'msg_wp226_todo_badjson_u', 'content', 'success', 0, '坏数据',                 1762003608000, 1762003608000),
('blk_wp226_todo_badjson_a',  'msg_wp226_todo_badjson',   'content', 'success', 0, '坏数据回复。',           1762003609000, 1762003609500);

INSERT INTO chat_v2_todo_lists (session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done, created_at, updated_at) VALUES
('sess_wp226_todo_open', 'msg_wp226_todo_open', NULL, 'todo_wp226_open', '复习第二章',
 '[{"id":"step_0","description":"读概念","status":"completed","result":"已读","createdAt":1762003601000,"updatedAt":1762003601200},{"id":"step_1","description":"做例题","status":"running","createdAt":1762003601000},{"id":"step_2","description":"总结","status":"pending","createdAt":1762003601000}]',
 0, 1762003601000, 1762003601200),
('sess_wp226_todo_open2', 'msg_wp226_todo_open2', NULL, 'todo_wp226_open2', '整理错题',
 '[{"id":"step_0","description":"收集错题","status":"pending","createdAt":1762003603000},{"id":"step_1","description":"分类","status":"pending","createdAt":1762003603000}]',
 0, 1762003603000, 1762003603000),
('sess_wp226_todo_alldone', 'msg_wp226_todo_alldone', NULL, 'todo_wp226_alldone', '已结束任务',
 '[{"id":"step_0","description":"A","status":"completed","result":"ok","createdAt":1762003605000,"updatedAt":1762003605100},{"id":"step_1","description":"B","status":"failed","result":"超时","createdAt":1762003605000,"updatedAt":1762003605200},{"id":"step_2","description":"C","status":"skipped","createdAt":1762003605000,"updatedAt":1762003605300}]',
 0, 1762003605000, 1762003605300),
('sess_wp226_todo_flagged', 'msg_wp226_todo_flagged', NULL, 'todo_wp226_flagged', '标记完成',
 '[{"id":"step_0","description":"A","status":"pending","createdAt":1762003607000}]',
 1, 1762003607000, 1762003607000),
('sess_wp226_todo_badjson', 'msg_wp226_todo_badjson', NULL, 'todo_wp226_badjson', '坏步骤',
 '{"steps":"not-an-array"}',
 0, 1762003609000, 1762003609000);
