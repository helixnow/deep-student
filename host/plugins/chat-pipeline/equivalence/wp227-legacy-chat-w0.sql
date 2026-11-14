-- Seed wp227-legacy-chat-w0 (pending owner X3: seed directory mechanism).
-- Apply to mistakes.db of a data directory that the app has already started once
-- (schema from src-tauri/migrations/mistakes/V20260130__init.sql:14-64 plus later
-- ALTERs in V20260201 / V20260523), with the app stopped. The AFTER INSERT change_log
-- triggers from V20260131__add_change_log.sql fire on both sides; that is part of the input.
--
-- Why a seed: chat_v2_rollback_migration (handlers/migration.rs:53 ->
-- migration/legacy_migration.rs:936) only resets rows that chat_v2_migrate_legacy_chat
-- moved out of the legacy mistakes.db chat_messages table. No frontend-reachable command
-- writes legacy chat_messages rows (the legacy mistake chat UI was removed), so in an
-- `empty` data dir rollback can only reach "no such column: migrated_to_v2" or a zero-row
-- report. These rows let migrate create real v2 sessions that rollback must delete.
--
-- The migrated_to_v2 / migrated_session_id columns are NOT created here: the app adds them
-- lazily (legacy_migration.rs:792-801). Keep it that way so the first migrate exercises the
-- ALTER path on both sides.

INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text, ocr_note, tags, mistake_type, status, chat_category, updated_at, chat_metadata) VALUES
('mst_wp227_titled', '2025-03-01T08:00:00Z', '[]', '[]', '求导 y=x^2', 'y=x^2 的导数', NULL, '["数学","导数"]', 'calc', 'summary', 'analysis', '2025-03-01T08:10:00Z', '{"title":"导数错题（元数据标题）","summary":null}'),
('mst_wp227_ocr', '2025-03-02T08:00:00Z', '[]', '[]', '', '一段很长的 OCR 文本，用来验证标题截断规则：第一句。第二句。第三句。第四句。第五句。第六句。第七句。', 'note', '[]', '', 'analysis', 'analysis', '2025-03-02T08:10:00Z', NULL),
('mst_wp227_question', '2025-03-03T08:00:00Z', '[]', '[]', '只有用户问题 "带引号" \ 反斜杠', '', NULL, '[]', '', 'analysis', 'analysis', '2025-03-03T08:10:00Z', NULL);

INSERT INTO chat_messages (mistake_id, role, content, timestamp, thinking_content, rag_sources, image_paths, stable_id, metadata) VALUES
('mst_wp227_titled', 'user', '为什么 y=x^2 的导数是 2x？', '2025-03-01T08:01:00Z', NULL, NULL, NULL, 'stable_wp227_t1', NULL),
('mst_wp227_titled', 'assistant', '按定义求极限：\n(x+h)^2-x^2 = 2xh + h^2，除以 h 再令 h→0 得 2x。', '2025-03-01T08:02:00Z', '先写差商', '[{"document_id":"d1","file_name":"导数.md","chunk_text":"差商","score":0.5,"chunk_index":0}]', NULL, 'stable_wp227_t2', '{"model":"legacy-model"}'),
('mst_wp227_titled', 'user', '那 y=x^3 呢？', '2025-03-01T08:03:00Z', NULL, NULL, '[]', NULL, NULL),
('mst_wp227_ocr', 'user', 'OCR 会话的问题', '2025-03-02T08:01:00Z', NULL, NULL, NULL, NULL, NULL),
('mst_wp227_ocr', 'assistant', 'OCR 会话的回答 🙂', '2025-03-02T08:02:00Z', NULL, NULL, NULL, NULL, NULL),
('mst_wp227_question', 'user', '只有一条用户消息', '2025-03-03T08:01:00Z', NULL, NULL, NULL, NULL, NULL);
