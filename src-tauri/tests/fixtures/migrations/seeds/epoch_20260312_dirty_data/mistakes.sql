-- Fixture seed: mistakes @ schema V20260209 (2026-02 epoch).

INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text,
                      tags, mistake_type, status, updated_at, chat_metadata)
VALUES
  ('mistake_dirty_1', '2026-03-12T12:00:00Z', '["img/m1.png"]', '[]',
   '导数计算错在哪里？', '题目 OCR：f(x)=x^2 sin x', '["数学","导数"]', 'calculation', 'done',
   '2026-03-12T12:00:00Z', '{"model":"deepseek-r1"}'),
  ('mistake_dirty_2', '2026-03-12T12:05:00Z', '[]', '[]',
   '占位错题（脏数据：非法 JSON 元数据）', 'OCR 文本', '["待整理"]', 'other', 'pending',
   '2026-03-12T12:05:00Z', '{"cut off');
