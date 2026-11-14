-- Goal 模式（P0）：会话级持久目标表（2026-09）。
--
-- goal 模式 = 会话级持久目标 + 轮末自动续跑 + 严格完成审计。每个会话至多
-- 一条目标记录（session_id 主键），跨轮次持续存在：本轮结束后运行时自动
-- 发起续跑轮继续推进，直到目标被标记 complete。
--
-- 状态机（status 列 CHECK 约束即权威定义）：
--   active          - 推进中（轮末自动续跑）
--   paused          - 用户暂停（仅 IPC 可设/解除）
--   blocked         - 模型标记：同一阻塞条件连续多轮无法推进
--   usage_limited   - 系统标记：用量受限，停止自动续跑
--   budget_limited  - 系统标记：token 预算耗尽，停止自动续跑
--   complete        - 模型标记：目标已达成（需逐条证据核实）
--   waiting_user    - 模型标记：等待用户回答/输入（学习域出题挂起）
--
-- 权限划分：模型仅可经 goal_update 设 complete/blocked/waiting_user；
-- pause/resume 走 IPC（用户控制）；usage_limited/budget_limited 由系统设置。
--
-- token_budget 为 NULL 表示无预算上限；tokens_used / time_used_seconds /
-- continuation_count 由运行时在每轮结束后累加，供预算熔断与审计。

CREATE TABLE IF NOT EXISTS chat_v2_goals (
    session_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete','waiting_user')),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    continuation_count INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_goals_status ON chat_v2_goals(status);
