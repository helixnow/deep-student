-- Seed l22-temp-sessions-w0 (pending owner X3: seed directory mechanism).
-- Apply to mistakes.db of a data directory that the app has already started once
-- (schema from src-tauri/migrations/mistakes/V20260130__init.sql:67-74,142-146), app stopped.
-- No frontend-reachable IPC command writes temp_sessions rows: cache_temp_session
-- (src-tauri/src/commands.rs:202) has no caller, temp_sessions is LocalRuntime (not synced,
-- dstu-sync classification.rs:1143-1150). Rows only come from historical data dirs or backups.
-- session_data is raw JSON text; its exact spelling (number lexemes, key order, escapes,
-- offsets) is part of the input and must be copied byte-for-byte.

-- Full StreamContext: deep optional fields present, Value-typed fields with null members,
-- duplicate keys, arbitrary-precision lexemes, unknown keys, non-UTC offsets, escapes.
INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error) VALUES (
'tmp_full',
'{"temp_id":"tmp_full","question_images":["iVBORw0KGgo=","data:image/png;base64,AAAA"],"analysis_images":[],"user_question":"it''s \"quoted\" \\ back\nline \u0001 \u2028 中文🙂","ocr_text":"","ocr_note":"note","tags":["数学"," 代数 ",""],"mistake_type":"calc","chat_category":"analysis","chat_metadata":{"title":"T","summary":null,"tags":[],"attributes":{"n":0.1000000000000000055511151231257827,"big":123456789012345678901234567890,"neg0":-0.0,"exp":1E400,"tiny":5e-324,"nested":{"k":null,"arr":[null,1.50,-1e-7]},"dup":1,"dup":2},"note":"m"},"chat_history":[{"role":"user","content":"q","timestamp":"2026-01-02T03:04:05.123456789+08:00","image_paths":[],"image_base64":["AAAA"],"multimodal_content":[{"type":"text","text":"t"},{"type":"image_url","mediaType":"image/png","base64":"AAAA"}],"doc_attachments":[{"name":"a.pdf","mime_type":"application/pdf","size_bytes":18446744073709551615,"text_content":null}],"overrides":null,"relations":{"r":[]},"metadata":{"x":null,"y":[1,2.000]},"unknown_extra":true},{"role":"assistant","content":"a","timestamp":"2026-01-02T03:04:05Z","thinking_content":"th","thought_signature":"sig","rag_sources":[{"document_id":"d1","file_name":"f.md","chunk_text":"c","score":0.1234567891,"chunk_index":0}],"memory_sources":[],"graph_sources":null,"web_search_sources":[{"document_id":"w","file_name":"","chunk_text":"","score":1e-46,"chunk_index":4294967296}],"tool_call":{"id":"call_1","tool_name":"search","args_json":{"q":"x","limit":10,"f":1.0e+2,"z":null}},"tool_result":{"call_id":"call_1","ok":false,"error":"boom","data_json":null,"usage":{"ms":12.50},"citations":[]},"persistent_stable_id":"stable-1"}],"initial_doc_attachments":[],"created_at":"2026-01-02T03:04:05.000000001+08:00","exam_sheet":{"exam_id":"exam_1","origin_exam_id":null,"page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.30000001,"height":1e-45},"tags":[],"mistake_type":"m"},"stream_state":"completed","bridge_context":{"source_id":"s","source_type":"chat","business_session_id":null},"last_error":"上一次错误"}',
'completed', '2026-01-01T19:04:05.000000001+00:00', '2026-01-01T19:04:05+00:00', '上一次错误');

-- Minimal StreamContext: only required fields, mistake_id alias for temp_id, stream_state
-- defaulted; the row columns intentionally disagree with the JSON (upsert overwrites them).
INSERT INTO temp_sessions VALUES (
'tmp_min',
'{"mistake_id":"tmp_min","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z"}',
'failed', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'stale column error');

-- Already pinned session with its settings mirror.
INSERT INTO temp_sessions VALUES (
'tmp_pinned',
'{"temp_id":"tmp_pinned","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"pinned_images":["P1","P2"],"created_at":"2026-01-01T00:00:00Z","stream_state":"in_progress"}',
'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
INSERT INTO settings (key, value, updated_at) VALUES ('pinned_images:tmp_pinned', '["P1","P2"]', '2026-01-01T00:00:00+00:00');

-- Row key differs from the temp_id inside session_data: upsert writes the inner key.
INSERT INTO temp_sessions VALUES (
'tmp_mismatch_outer',
'{"temp_id":"tmp_mismatch_inner","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z"}',
'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);

-- Persist-failure row: the upsert (ON CONFLICT DO UPDATE) is aborted by a trigger.
INSERT INTO temp_sessions VALUES (
'tmp_readonly',
'{"temp_id":"tmp_readonly","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z"}',
'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
INSERT INTO settings (key, value, updated_at) VALUES ('pinned_images:tmp_readonly', '["R"]', '2026-01-01T00:00:00+00:00');
CREATE TRIGGER w0_temp_sessions_readonly BEFORE UPDATE ON temp_sessions
WHEN OLD.temp_id = 'tmp_readonly'
BEGIN SELECT RAISE(ABORT, 'w0 seed: temp_sessions row is read-only'); END;

-- Eviction rows (TEMP_SESSION_MEMORY_CAP = 8, commands.rs:181-199): evict_1 and evict_2
-- share the oldest created_at so the temp_id tie-break decides.
INSERT INTO temp_sessions VALUES ('tmp_evict_1', '{"temp_id":"tmp_evict_1","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:01Z"}', 'in_progress', '2026-01-01T00:00:01+00:00', '2026-01-01T00:00:01+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_2', '{"temp_id":"tmp_evict_2","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:01Z"}', 'in_progress', '2026-01-01T00:00:01+00:00', '2026-01-01T00:00:01+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_3', '{"temp_id":"tmp_evict_3","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:03Z"}', 'in_progress', '2026-01-01T00:00:03+00:00', '2026-01-01T00:00:03+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_4', '{"temp_id":"tmp_evict_4","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:04Z"}', 'in_progress', '2026-01-01T00:00:04+00:00', '2026-01-01T00:00:04+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_5', '{"temp_id":"tmp_evict_5","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:05Z"}', 'in_progress', '2026-01-01T00:00:05+00:00', '2026-01-01T00:00:05+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_6', '{"temp_id":"tmp_evict_6","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:06Z"}', 'in_progress', '2026-01-01T00:00:06+00:00', '2026-01-01T00:00:06+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_7', '{"temp_id":"tmp_evict_7","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:07Z"}', 'in_progress', '2026-01-01T00:00:07+00:00', '2026-01-01T00:00:07+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_8', '{"temp_id":"tmp_evict_8","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:08Z"}', 'in_progress', '2026-01-01T00:00:08+00:00', '2026-01-01T00:00:08+00:00', NULL);
INSERT INTO temp_sessions VALUES ('tmp_evict_9', '{"temp_id":"tmp_evict_9","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:09Z"}', 'in_progress', '2026-01-01T00:00:09+00:00', '2026-01-01T00:00:09+00:00', NULL);

-- Read-failure rows (get_temp_session_record, dstu-storage database/mod.rs:4197-4216).
-- Missing required fields.
INSERT INTO temp_sessions VALUES ('tmp_bad_empty_obj', '{}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Not JSON.
INSERT INTO temp_sessions VALUES ('tmp_bad_not_json', 'not json', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- BLOB storage class: rusqlite row.get::<String> fails with InvalidColumnType.
INSERT INTO temp_sessions VALUES ('tmp_bad_blob', X'7B7D', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Negative usize (DocumentAttachment.size_bytes).
INSERT INTO temp_sessions VALUES ('tmp_bad_negative_usize', '{"temp_id":"tmp_bad_negative_usize","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"initial_doc_attachments":[{"name":"a","mime_type":"m","size_bytes":-1}],"created_at":"2026-01-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- usize overflow (> u64::MAX).
INSERT INTO temp_sessions VALUES ('tmp_bad_usize_overflow', '{"temp_id":"tmp_bad_usize_overflow","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"initial_doc_attachments":[{"name":"a","mime_type":"m","size_bytes":18446744073709551616}],"created_at":"2026-01-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Unknown TempStreamState variant.
INSERT INTO temp_sessions VALUES ('tmp_bad_state', '{"temp_id":"tmp_bad_state","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z","stream_state":"paused"}', 'paused', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Duplicate struct field (serde derive rejects; Value maps keep last).
INSERT INTO temp_sessions VALUES ('tmp_bad_dup_field', '{"temp_id":"tmp_bad_dup_field","question_images":[],"analysis_images":[],"user_question":"a","user_question":"b","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Lone UTF-16 surrogate escape (serde_json rejects, JSON.parse accepts).
INSERT INTO temp_sessions VALUES ('tmp_bad_lone_surrogate', '{"temp_id":"tmp_bad_lone_surrogate","question_images":[],"analysis_images":[],"user_question":"\ud800","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-01-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
-- Invalid created_at.
INSERT INTO temp_sessions VALUES ('tmp_bad_created_at', '{"temp_id":"tmp_bad_created_at","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[],"created_at":"2026-13-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);

-- f32 out of range (RagSourceInfo.score = 1e40): the oracle decides whether it decodes and
-- how it re-serializes; not labelled success or error here.
INSERT INTO temp_sessions VALUES ('tmp_f32_overflow', '{"temp_id":"tmp_f32_overflow","question_images":[],"analysis_images":[],"user_question":"","ocr_text":"","tags":[],"mistake_type":"","chat_category":"","chat_history":[{"role":"assistant","content":"","timestamp":"2026-01-01T00:00:00Z","rag_sources":[{"document_id":"d","file_name":"f","chunk_text":"c","score":1e40,"chunk_index":0}]}],"created_at":"2026-01-01T00:00:00Z"}', 'in_progress', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', NULL);
