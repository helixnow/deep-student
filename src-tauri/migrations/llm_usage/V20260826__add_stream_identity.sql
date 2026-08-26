-- ============================================================================
-- V20260826: llm_usage_logs 增加 variant_id / run_id（遥测身份分列）
-- ============================================================================
--
-- 此前 model2 流式路径把整个 run-scoped stream_event（形如
-- chat_v2_event_{session}_var_{scope}_run_{run}[__stream_generation__{n}]）
-- 整体当作 session_id 落库，导致：
--   1. 报表按 session 聚合时，每次 pipeline 执行都被当成独立会话，
--      跨轮 steady-state 缓存命中率统计彻底失真；
--   2. 多变体（variant）与单次执行（run）维度无法区分。
--
-- 自本版本起 Chat V2 流式写入路径分列三个身份字段：
--   - session_id（既有列）：真实 Chat V2 会话 ID（`chat_v2_event_` 与
--     `_var_` 之间的部分）；
--   - variant_id（新列）：多变体/流作用域 ID（`_var_` 与 `_run_` 之间），
--     单变体路径为该流作用域（assistant 消息作用域）；
--   - run_id（新列）：单次 pipeline 执行的 run key（`_run_` 之后，去掉
--     代际后缀）。代际（__stream_generation__N）只用于流路由，不入库。
--
-- 列可空：NULL = 未知（历史数据 / 非 chat_v2 调用方 / 旧格式事件名），
-- 报表侧（scripts/cache-hit-report.py）缺列或 NULL 时需降级为旧口径。
ALTER TABLE llm_usage_logs ADD COLUMN variant_id TEXT;
ALTER TABLE llm_usage_logs ADD COLUMN run_id TEXT;

-- 变体维度聚合索引（多变体 steady-state 统计按 session_id + variant_id 分组）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_variant_id
    ON llm_usage_logs(variant_id)
    WHERE variant_id IS NOT NULL;

-- run 维度索引（单次执行内多轮工具调用的请求序列还原）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_run_id
    ON llm_usage_logs(run_id)
    WHERE run_id IS NOT NULL;
