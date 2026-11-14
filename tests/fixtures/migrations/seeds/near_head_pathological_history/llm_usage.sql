-- Fixture seed: llm_usage @ schema V20260524 (only V20260525 pending).

INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type,
                            prompt_tokens, completion_tokens, total_tokens, reasoning_tokens)
VALUES
  ('usage_nh_000001', '2026-07-20T13:00:00.000Z', 'anthropic', 'claude-sonnet-5', 'chat',
   2400, 800, 3200, 512);
