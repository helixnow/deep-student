-- V20260210: 新增 answer_submissions 表 + questions 表 AI 缓存列
--
-- answer_submissions: 记录每次作答的历史记录（不再仅覆盖最新答案）
-- questions 新增列: ai_feedback, ai_score, ai_graded_at（缓存最新一次 AI 评判结果）

-- 1. 新增 answer_submissions 表
CREATE TABLE IF NOT EXISTS answer_submissions (
    id TEXT PRIMARY KEY NOT NULL,                   -- 格式: as_{nanoid(10)}
    question_id TEXT NOT NULL,                      -- 所属题目 FK -> questions
    user_answer TEXT NOT NULL,                      -- 用户本次提交的答案
    is_correct INTEGER,                             -- NULL=待评判, 0=错误, 1=正确
    grading_method TEXT NOT NULL DEFAULT 'auto',    -- auto | manual | ai
    submitted_at TEXT NOT NULL,                     -- 提交时间 ISO8601
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

-- 按 question_id + 时间倒序索引（查询某题的历次作答）
CREATE INDEX IF NOT EXISTS idx_submissions_question
    ON answer_submissions(question_id, submitted_at DESC);

-- 2. questions 表新增 AI 评判缓存列（最新一次）
ALTER TABLE questions ADD COLUMN ai_feedback TEXT;      -- AI 评判/解析文本
ALTER TABLE questions ADD COLUMN ai_score INTEGER;      -- AI 评分 0-100（主观题）
ALTER TABLE questions ADD COLUMN ai_graded_at TEXT;     -- AI 评判时间 ISO8601
