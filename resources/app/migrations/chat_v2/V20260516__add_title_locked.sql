-- 为 chat_v2_sessions 添加 title_locked 字段
--
-- 业界最佳实践：用户手动改名后永久锁定标题，自动摘要 LLM 不再覆盖。
-- 配合 summary_hash IS NULL 的「首轮唯一」生成策略，达到 ChatGPT/Claude 风格行为。
--
-- 0 = AI 可写（默认）
-- 1 = 用户已锁定，自动摘要永不覆盖
ALTER TABLE chat_v2_sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
