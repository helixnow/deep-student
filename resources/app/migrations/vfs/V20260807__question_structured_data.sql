-- ============================================================================
-- 题目结构化数据列（题型扩展契约）
--
-- 新增 questions.structured_data TEXT（JSON 字符串，可空），承载新题型
-- （true_false / matching / ordering / numeric）与增强填空题的结构化答案：
--   - fill_blank: {"blanks":[{"answers":["答案1","答案一"],"case_sensitive":false,"trim":true}]}
--   - matching:   {"left":[{"key":"L1","content":"..."}],"right":[{"key":"R1","content":"..."}],
--                  "pairs":[{"left":"L1","right":"R2"}]}
--   - ordering:   {"items":[{"key":"A","content":"..."}],"correct_order":["B","A","C"]}
--   - numeric:    {"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}
--   - true_false: 不使用 structured_data，answer 为 "true"|"false"
--
-- 该列不参与 FTS5 索引（questions_fts 触发器只覆盖 content/answer/explanation/tags），
-- 因此无需重建索引或调整触发器。
-- ============================================================================

ALTER TABLE questions ADD COLUMN structured_data TEXT;
