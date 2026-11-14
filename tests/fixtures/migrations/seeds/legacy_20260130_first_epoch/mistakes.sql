-- Fixture seed: mistakes @ schema V20260130 (oldest consolidated epoch)
-- Two mistakes rows: one fully populated, one degenerate (empty OCR text,
-- empty JSON arrays, NULL chat_metadata).

INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text,
                      tags, mistake_type, status, updated_at, chat_metadata)
VALUES
  ('mistake_legacy_1', '2026-01-30T12:00:00Z', '["img/q1.png"]', '["img/a1.png"]',
   '为什么这道题选 B？', '原题 OCR 文本：动量守恒……', '["物理","力学"]', 'concept', 'done',
   '2026-01-30T12:00:00Z', '{"model":"gpt-4o"}'),
  ('mistake_legacy_2', '2026-01-30T12:05:00Z', '[]', '[]',
   '空白题目占位', '', '[]', 'other', 'pending',
   '2026-01-30T12:05:00Z', NULL);
