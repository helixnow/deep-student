-- ============================================================================
-- V20260909: 技能使用后端账目 + 经验候选库（G09-P0）
-- ============================================================================
--
-- "经验证的经验积累"第一块积木：**只记录，不回放**。
--
-- skill_usage：每次技能使用的后端权威账目。此前技能使用统计只有前端
-- localStorage 计数（activations/toolLoads/lastUsedAt），无 outcome、无
-- token/延迟、无 run 关联。本表把使用事件锚定到会话与运行：
--   - run_id = 一次助手回合的 assistant_message_id；前端激活事件不属于任何
--     run，run_id 为 NULL。
--   - kind 区分两条写入通路，避免双计：
--       'activation' —— 前端显式激活（面板点击/斜杠命令/默认注入），由
--                      chat_v2_record_skill_activation 命令写入，loads 恒 0；
--       'tool_load'  —— 轮末钩子从 ctx.tool_results 扫描成功的 load_skills
--                      调用写入，loads = 该 run 内请求次数。
--   - outcome 本阶段恒为 'unknown'，待 G07 TaskFinalizer 终态产出后由
--     finalizer 对接收敛为 success/failed（user_corrected 由轮末钩子检测到
--     edit_and_resend/retry 信号时回写上一轮 run 的账目行）。
--   - latency_ms / tokens 为 run 级总量（同一 run 的多行技能账目共享该值），
--     非单技能粒度。
--
-- skill_candidates：经验候选库。轮末零 LLM 成本检测产出：
--   - trajectory：任务成功完成（save_results 事务提交）+ 成功工具调用序列
--     ≥3 个不同工具 + 本轮非纠错触发 → 正例候选；
--   - user_correction：edit_and_resend/retry 信号 → 反例候选（标记前一轮
--     run 被用户纠正）。
--   隐私边界：draft_payload_json 只存工具名序列摘要与统计数字（工具名/技能
--   ID/计数/耗时/token 数），**不存任何用户消息内容、助手回复内容、工具
--   输入输出**；evidence_refs_json 只存不透明 id 引用。
--   status 状态机（CHECK 约束即权威定义；合法迁移守卫在 repo 层原子
--   UPDATE ... WHERE status = 期望前驱）：
--     new → screened → replaying → passed/failed → published → rolled_back
--   trace_hash 全局唯一： trajectory 按 (session + 工具序列) 去重，
--   user_correction 按 (session + 被纠正 run) 去重。
--
-- @danger-ack: unique_constraint reason="新表无既有数据，唯一索引仅约束新写入的 trace_hash 去重键"

CREATE TABLE IF NOT EXISTS skill_usage (
    usage_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    task_session_id TEXT NOT NULL DEFAULT '',
    run_id TEXT,
    kind TEXT NOT NULL DEFAULT 'tool_load'
        CHECK(kind IN ('activation','tool_load')),
    loads INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK(outcome IN ('success','failed','user_corrected','unknown')),
    latency_ms INTEGER,
    tokens INTEGER,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_created
    ON skill_usage(skill_id, created_at);

CREATE INDEX IF NOT EXISTS idx_skill_usage_session_created
    ON skill_usage(task_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_skill_usage_run
    ON skill_usage(run_id);

CREATE INDEX IF NOT EXISTS idx_skill_usage_outcome
    ON skill_usage(outcome);

CREATE TABLE IF NOT EXISTS skill_candidates (
    candidate_id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('trajectory','user_correction')),
    session_id TEXT NOT NULL,
    trace_hash TEXT NOT NULL,
    draft_payload_json TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new','screened','replaying','passed','failed','published','rolled_back')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_candidates_trace_hash
    ON skill_candidates(trace_hash);

CREATE INDEX IF NOT EXISTS idx_skill_candidates_status_created
    ON skill_candidates(status, created_at);

CREATE INDEX IF NOT EXISTS idx_skill_candidates_session_created
    ON skill_candidates(session_id, created_at);
