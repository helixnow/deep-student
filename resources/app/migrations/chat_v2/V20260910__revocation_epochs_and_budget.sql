-- ============================================================================
-- V20260910: 撤权 epoch 落库（G02-P2）+ 预算快照落库（G08-P2）
-- ============================================================================
--
-- revocation_epochs：DelegatedGrant 撤权 epoch 的持久轴（进程内语义见
-- chat_v2/grants.rs）。撤权是终态且必须跨重启存活——否则重启即静默回滚
-- 撤权。两类行共用一张表：
--   - (kind='global', task_id='')：全局 epoch，恰好一行（revoke_all_grants）；
--   - (kind='task',   task_id=<child_task_id>)：per-task epoch，每任务一行
--     （revoke_grants_for）。
-- 主键为 (kind, task_id) 复合键：task 行靠 task_id 区分，单 kind 主键无法
-- 容纳多任务行（全局行以 task_id='' 占位保证唯一）。epoch 单调递增、永不
-- 复用；bump 先写库再更新内存（fail-closed），启动时加载恢复（无行 → 0）。
--
-- budget_snapshots：任务树根账本（chat_v2/budget.rs BudgetLedger）的持久
-- 快照。防"重启/模型切换/重试重置任务累计预算"——启动时对未完成的任务树
-- 恢复账本（按 created_at_unix 推算已耗时，超时树恢复即 exhausted）。
--   - root_id：任务树根 id（第一代 worker 的根 = 父会话 id）；
--   - limits_json：该代账本的三维上限快照（生成代时的有效值，settings
--     后续变更不回溯旧代）；
--   - usage_json：已用量快照（tool_calls/tokens_in/tokens_out/已耗时与
--     created_at_unix 锚点）。
-- 写入点：账本创建 / 超额（指纹去重）/ worker 绑定解绑；恢复不回写本表
-- （恢复后由正常运行路径的写入点继续推进）。
--
-- 两表均无既有数据、无唯一索引之外的约束风险，纯 CREATE TABLE IF NOT EXISTS，
-- 幂等可重放。

CREATE TABLE IF NOT EXISTS revocation_epochs (
    kind TEXT NOT NULL CHECK(kind IN ('global','task')),
    task_id TEXT NOT NULL DEFAULT '',
    epoch INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, task_id)
);

CREATE TABLE IF NOT EXISTS budget_snapshots (
    root_id TEXT PRIMARY KEY,
    limits_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
