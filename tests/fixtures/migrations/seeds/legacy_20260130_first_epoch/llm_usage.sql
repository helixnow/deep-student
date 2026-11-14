-- Fixture seed: llm_usage @ schema V20260130 (oldest consolidated epoch)
-- Two usage logs (one with NULL optional metrics) and one daily aggregate row.
-- The fixture harness additionally drops refinery_schema_history and installs
-- the legacy schema_version marker table (ensure_legacy_baseline path).

INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type,
                            prompt_tokens, completion_tokens, total_tokens)
VALUES
  ('usage_legacy_0001', '2026-01-30T13:00:00.000Z', 'anthropic', 'claude-3-opus', 'chat',
   1200, 340, 1540),
  ('usage_legacy_0002', '2026-01-30T13:05:00.000Z', 'deepseek', 'deepseek-chat', 'translation',
   0, 0, 0);

INSERT INTO llm_usage_daily (date, caller_type, model, provider,
                             request_count, success_count, error_count,
                             total_prompt_tokens, total_completion_tokens, total_tokens)
VALUES ('2026-01-30', 'chat', 'claude-3-opus', 'anthropic', 2, 2, 0, 1200, 340, 1540);
