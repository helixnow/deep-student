-- G03-a：子代理完成投递持久账本（completion outbox）。
--
-- 权威记录"worker 完成 → 父会话投递"的事实与投递状态。旧链路里唤醒责任
-- 100% 在前端 subagentIdleWake 内存队列（父 store 2 分钟重试上限后永久
-- 放弃），进程重启 / 窗口缺席 / 前端放弃都会静默丢失唤醒。本表把完成信封
-- 固化为持久行，由后端 CompletionDispatcher 以租约轮询收敛到 delivered。
--
-- 写入方：worker 管线完成闭包（workspace_handlers.rs），顺序为
--   outbox(pending) → inbox Result 消息 → task 终态 → outbox(delivered) → emit。
-- inbox/task 在 workspace 独立库（ws_{id}.db），与 chat_v2 主库跨库：
-- 先落 outbox 保证"完成事实"有源可循，崩溃遗留的 pending 行由 dispatcher
-- 对账重投（查重按 run_id 命中 workspace message 表即收敛 delivered）。
--
-- 幂等键：run_id 唯一（worker 每次运行的 assistant_message_id，全局唯一），
-- 重复入帐经 INSERT OR IGNORE 命中即知已投递过。

CREATE TABLE IF NOT EXISTS completion_outbox (
    delivery_id       TEXT PRIMARY KEY,
    -- 关联的 subagent_task.id（workspace 独立库；跨库仅弱引用，无外键）
    task_id           TEXT,
    -- worker 本次运行标识（assistant_message_id），幂等键
    run_id            TEXT NOT NULL,
    workspace_id      TEXT NOT NULL,
    agent_session_id  TEXT NOT NULL,
    -- 投递目标（父/主代理会话）
    target_session_id TEXT NOT NULL,
    -- 父会话运行代际标识（完成时刻的 correlation_id，即触发该子代理的父会话
    -- 消息 id）。P0 仅作审计/对账记录；精细的"代际已越过"失效判定留待后续。
    target_generation TEXT,
    -- AgentCompletionEnvelope 序列化原文（投递时直接作为 message content / emit 载荷）
    payload_json      TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'claimed', 'delivered', 'expired')),
    claim_owner       TEXT,
    claim_expiry      TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    delivered_at      TEXT
);

-- @danger-ack: unique_constraint reason="新表配套唯一索引，无既有数据，不存在重复行导致迁移失败的风险；run_id 唯一是投递幂等的根基"
CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_outbox_run
    ON completion_outbox(run_id);

CREATE INDEX IF NOT EXISTS idx_completion_outbox_state
    ON completion_outbox(state, claim_expiry);

CREATE INDEX IF NOT EXISTS idx_completion_outbox_target
    ON completion_outbox(target_session_id, state);
