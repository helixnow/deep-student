-- Seed spec f3-llm-usage-rows-w0 (WP-236). Apply to llm_usage.db of a data directory that has
-- started once (migrations V20260130..V20260826 applied) and is stopped. Owner of the seed
-- mechanism: X3 (host/e2e/data-compat). Rows exercise:
--   * every CallerType branch kind (known, "other:" prefix, bare unknown) in by_caller/recent;
--   * success/error status counts in summary/daily;
--   * a non-RFC3339 timestamp (recent → epoch fallback + warn, trends first_ts → 0);
--   * NULL cost_estimate / duration_ms next to non-NULL values;
--   * session_id = 'sess_wp236_a' for llm_usage_session_summary;
--   * date_key spread across 2026-09-30 .. 2026-10-03 so cleanup('2026-10-02') deletes a subset.
INSERT INTO llm_usage_logs (id, timestamp, provider, model, adapter, api_config_id,
  prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, cached_tokens, token_source,
  duration_ms, caller_type, session_id, status, error_message, cost_estimate,
  cache_write_tokens, variant_id, run_id)
VALUES
  ('wp236-u1', '2026-09-30T23:59:59.999+00:00', 'openai', 'gpt-4o-mini', 'openai', 'cfg-1',
   100, 50, 150, NULL, 10, 'api', 1200, 'chat_v2', 'sess_wp236_a', 'success', NULL, 0.0015,
   NULL, 'var-1', 'run-1'),
  ('wp236-u2', '2026-10-01T08:00:00+00:00', 'openai', 'gpt-4o-mini', 'openai', 'cfg-1',
   200, 100, 300, 20, NULL, 'api', 800, 'chat_v2', 'sess_wp236_a', 'error', 'HTTP 429', NULL,
   5, NULL, NULL),
  ('wp236-u3', '2026-10-01T09:30:00Z', 'anthropic', 'claude-x', 'anthropic', 'cfg-2',
   1000, 0, 1000, NULL, NULL, 'estimate', NULL, 'translation', NULL, 'success', NULL, 0.01,
   NULL, NULL, NULL),
  ('wp236-u4', '2026-10-02 10:00:00', 'local', 'qwen', NULL, NULL,
   7, 3, 10, NULL, NULL, 'api', 50, 'other:custom_tool', 'sess_wp236_b', 'success', NULL, NULL,
   NULL, NULL, NULL),
  ('wp236-u5', '2026-10-03T00:00:00+08:00', 'local', 'qwen', NULL, NULL,
   0, 0, 0, NULL, NULL, 'api', 0, 'weird_caller', NULL, 'cancelled', NULL, 0.0,
   NULL, NULL, NULL);
