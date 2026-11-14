-- Fixture seed: llm_usage @ schema V20260525 (already at HEAD of this set).

INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type,
                            prompt_tokens, completion_tokens, total_tokens)
VALUES
  ('usage_gap_00001', '2026-05-23T13:00:00.000Z', 'openai', 'gpt-4o-mini', 'ocr',
   400, 120, 520);
