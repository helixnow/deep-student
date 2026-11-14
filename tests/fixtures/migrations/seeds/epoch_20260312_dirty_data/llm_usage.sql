-- Fixture seed: llm_usage @ schema V20260202 (2026-02 epoch, change_log present).

INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type,
                            prompt_tokens, completion_tokens, total_tokens, adapter)
VALUES
  ('usage_dirty_0001', '2026-03-12T13:00:00.000Z', 'openai', 'gpt-4o', 'essay_grading',
   987654321, 123456789, 1111111110, NULL);
