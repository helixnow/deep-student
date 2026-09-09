-- ============================================================================
-- V20260907: Connector 操作持久账本（G04-P0）
-- ============================================================================
--
-- 外部副作用操作（connector_operation_draft/confirm/commit）的持久状态机 +
-- 系统幂等键。权威状态落库后，进程重启不再丢失"已提交/提交中"的事实：
-- 遗留 submitting 行在下次启动时被收敛为 outcome_unknown
-- （见 chat_v2/connector_ledger.rs 的 reconcile_on_startup）。
--
-- 状态机（state 列 CHECK 约束即权威定义；合法迁移守卫在 repo 层的
-- 原子 UPDATE ... WHERE state IN (合法前驱)）：
--   draft           - 预览已创建，等待用户确认（受 expires_at_ms TTL 限制）
--   confirmed       - 用户已确认（确认绑定 preview_sha256）
--   submitting      - 已落库、正在调用 provider（先落库再调用）
--   committed       - provider 调用成功（终态；重复 commit 幂等返回既有结果）
--   outcome_unknown - 进程在 submitting 期间退出，远端结果未知（待 P2 reconcile）
--   failed          - provider 调用明确失败（终态）
--
-- idempotency_key 由系统在 draft 时生成：sha256(operation_id || preview_sha256)，
-- 不再接受模型提供的键。request_payload_hash 记录实际发往 provider 的
-- 参数哈希，供 P2 provider lookup reconcile 比对。
--
-- @danger-ack: unique_constraint reason="新表无既有数据，唯一索引仅约束新写入的幂等键"

CREATE TABLE IF NOT EXISTS connector_operations (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    capability TEXT,
    action TEXT NOT NULL,
    preview_sha256 TEXT,
    request_payload_hash TEXT,
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','confirmed','submitting','committed','outcome_unknown','failed')),
    external_operation_id TEXT,
    account_id TEXT,
    capability_fingerprint TEXT,
    preview_json TEXT,
    expires_at_ms INTEGER,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    submitted_at TEXT,
    resolved_at TEXT,
    error TEXT,
    evidence_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_operations_state
    ON connector_operations(state);

CREATE INDEX IF NOT EXISTS idx_connector_operations_created_at
    ON connector_operations(created_at);

CREATE INDEX IF NOT EXISTS idx_connector_operations_session_created
    ON connector_operations(session_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_operations_idempotency
    ON connector_operations(session_id, idempotency_key);
