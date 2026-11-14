-- ============================================================================
-- V20260910: Insight Recall v2 阶段三——insight_jobs 持久任务队列
-- ============================================================================
--
-- 仿 automation_runs（V20260714）的 lease + dedupe_key + next_attempt_at 模式：
--   - dedupe_key UNIQUE：同类同对象任务只排一次（enqueue 幂等）；
--   - lease（lease_owner + leased_at）：worker 崩溃后租约过期可被回收；
--   - next_attempt_at：失败退避重试；
--   - 启动恢复：running 但租约过期的任务由 worker 重置回 queued。
--
-- 任务类型（阶段三清单）：
--   srs_projection      源卡确认/修订 → SRS 物化卡重生成（D4：物化+回链）
--   merge_proposal      近重复卡检测 → 合并提案待办（linked-merge 保差异）
--   tag_canonicalize    标签归一化提案
--   principle_synthesis 原则卡合成（abstract_of 边 + ≥2 案例 + 1 反例）
--   principle_review    源卡更正 → 派生原则复审待办
--
-- 幂等性：CREATE IF NOT EXISTS / DROP IF EXISTS 全程幂等。
-- ============================================================================

CREATE TABLE IF NOT EXISTS insight_jobs (
    id TEXT PRIMARY KEY NOT NULL,                -- ijob_{nanoid(10)}
    job_type TEXT NOT NULL CHECK (job_type IN (
        'srs_projection', 'merge_proposal', 'tag_canonicalize',
        'principle_synthesis', 'principle_review'
    )),
    dedupe_key TEXT NOT NULL,                      -- 幂等键：{type}:{对象}:{版本}（唯一性由部分索引表达）
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    next_attempt_at TEXT,                        -- 退避：到点前不可被 claim
    lease_owner TEXT,                            -- worker 实例 id
    leased_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    -- 同步四列（本地队列也走同步：换机后任务不丢，dedupe_key 防双端重复执行）
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);

-- dedupe 唯一性只对未完成（queued/running）任务生效：
-- 完成/出错的同键任务不阻塞再次入队（对齐 anki_cards 部分索引惯例 V20260724）
-- @danger-ack: unique_constraint reason="insight_jobs 是本迁移新建的空表，不存在既有重复数据；部分索引只约束 queued/running 行"
CREATE UNIQUE INDEX IF NOT EXISTS idx_insight_jobs_dedupe_active
    ON insight_jobs(dedupe_key)
    WHERE status IN ('queued', 'running') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_insight_jobs_status_due
    ON insight_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_insight_jobs_lease
    ON insight_jobs(lease_owner, leased_at);
CREATE INDEX IF NOT EXISTS idx_insight_jobs_local_version
    ON insight_jobs(local_version);

-- change_log 触发器（云同步覆盖）
DROP TRIGGER IF EXISTS trg__change_log_insight_jobs_insert;
CREATE TRIGGER trg__change_log_insight_jobs_insert
AFTER INSERT ON insight_jobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_jobs', NEW.id, 'INSERT', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_jobs_update;
CREATE TRIGGER trg__change_log_insight_jobs_update
AFTER UPDATE ON insight_jobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_jobs', NEW.id, 'UPDATE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_insight_jobs_delete;
CREATE TRIGGER trg__change_log_insight_jobs_delete
AFTER DELETE ON insight_jobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('insight_jobs', OLD.id, 'DELETE', datetime('now'));
END;
