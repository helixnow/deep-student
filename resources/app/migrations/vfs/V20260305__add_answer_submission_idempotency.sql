-- V20260305: 为 answer_submissions 增加客户端请求幂等键
--
-- 目标：
-- 1) 支持提交答案重试时的去重（避免重复累计 attempt_count/correct_count）
-- 2) 为 submit_answer 提供 client_request_id 级别幂等保障

ALTER TABLE answer_submissions ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_question_request_id
    ON answer_submissions(question_id, client_request_id)
    WHERE client_request_id IS NOT NULL;
