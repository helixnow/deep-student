//! Connector 操作持久账本（G04-P0）。
//!
//! 外部副作用操作（`connector_operation_draft/confirm/commit`）的持久状态机
//! 与系统幂等键存储。权威状态在 chat_v2 库 `connector_operations` 表
//! （迁移 V20260907），替代旧的进程内 `PENDING`/`COMMITTED` Map——重启后
//! "已提交/提交中"的事实不再丢失。
//!
//! 核心不变量：**submitting 先于 provider 调用落库**。进程在调用期间退出时，
//! 遗留的 submitting 行无法区分"远端已执行但响应丢失"与"远端未执行"，下次
//! 启动由 [`reconcile_on_startup`] 收敛为 `outcome_unknown`（P2 再接
//! provider lookup 核销为 committed/failed）。
//!
//! 状态迁移全部走原子 `UPDATE ... WHERE state IN (合法前驱)`（前驱列表由
//! [`ConnectorOperationState::can_transition`] 单一来源推导），消除
//! "读-判-写"竞态窗口；`changes() == 0` 即非法迁移。

use std::sync::Arc;

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::database::ChatV2Database;

/// 操作状态机（与迁移 V20260907 的 CHECK 约束一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorOperationState {
    /// 预览已创建，等待用户确认。
    Draft,
    /// 用户已确认（绑定 preview_sha256，受 TTL 限制）。
    Confirmed,
    /// 已落库、正在调用 provider。
    Submitting,
    /// provider 调用成功（终态）。
    Committed,
    /// 进程在 submitting 期间退出，远端结果未知（待 P2 reconcile）。
    OutcomeUnknown,
    /// provider 调用明确失败（终态）。
    Failed,
}

impl ConnectorOperationState {
    /// 全部状态（用于从 [`Self::can_transition`] 推导合法前驱列表）。
    pub const ALL: [Self; 6] = [
        Self::Draft,
        Self::Confirmed,
        Self::Submitting,
        Self::Committed,
        Self::OutcomeUnknown,
        Self::Failed,
    ];

    /// 状态的数据库字符串表示。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Confirmed => "confirmed",
            Self::Submitting => "submitting",
            Self::Committed => "committed",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Failed => "failed",
        }
    }

    /// 从数据库字符串解析状态。
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|state| state.as_str() == raw)
    }

    /// 校验状态机迁移是否合法。
    ///
    /// 规则（无自环——重复 confirm/submit 是调用方 bug，应显式报错；
    /// commit 的幂等重放在 executor 层经"读取已提交结果"实现，不依赖迁移幂等）：
    /// - `Draft` → `Confirmed`
    /// - `Confirmed` → `Submitting`
    /// - `Submitting` → `Committed` / `Failed` / `OutcomeUnknown`
    /// - `OutcomeUnknown` → `Committed` / `Failed`（P2 provider lookup 预留）
    /// - `Committed` / `Failed` 为终态，不允许任何外向转换
    pub fn can_transition(from: Self, to: Self) -> bool {
        matches!(
            (from, to),
            (Self::Draft, Self::Confirmed)
                | (Self::Confirmed, Self::Submitting)
                | (Self::Submitting, Self::Committed)
                | (Self::Submitting, Self::Failed)
                | (Self::Submitting, Self::OutcomeUnknown)
                | (Self::OutcomeUnknown, Self::Committed)
                | (Self::OutcomeUnknown, Self::Failed)
        )
    }

    /// 目标状态的合法前驱列表，渲染为 SQL IN 子句内容。
    /// 值全部来自可信常量 [`Self::as_str`]，可安全内插 SQL。
    fn predecessors_sql(to: Self) -> String {
        Self::ALL
            .iter()
            .copied()
            .filter(|from| Self::can_transition(*from, to))
            .map(|state| format!("'{}'", state.as_str()))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// 系统幂等键：`sha256(operation_id || preview_sha256)`。
///
/// draft 时生成并随账本行持久化；对同一 operation 完全确定，confirm/commit
/// 不接受模型提供的键（模型传了只 warn 并忽略）。
pub fn system_idempotency_key(operation_id: &str, preview_sha256: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(operation_id.as_bytes());
    hasher.update(preview_sha256.as_bytes());
    hex::encode(hasher.finalize())
}

/// `connector_operations` 表的完整行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorOperation {
    pub operation_id: String,
    pub session_id: String,
    pub provider_id: String,
    pub capability: Option<String>,
    pub action: String,
    pub preview_sha256: Option<String>,
    pub request_payload_hash: Option<String>,
    pub idempotency_key: String,
    pub state: ConnectorOperationState,
    pub external_operation_id: Option<String>,
    pub account_id: Option<String>,
    pub capability_fingerprint: Option<String>,
    /// draft 预览（`DraftPreview` JSON），commit 时据此重建 provider 参数。
    pub preview_json: Option<String>,
    /// 确认 TTL 截止（epoch 毫秒）；NULL 表示不过期。
    pub expires_at_ms: Option<i64>,
    pub created_at: String,
    pub confirmed_at: Option<String>,
    pub submitted_at: Option<String>,
    pub resolved_at: Option<String>,
    pub error: Option<String>,
    /// 终态证据：committed 时为完整输出 JSON（幂等重放原样返回）。
    pub evidence_json: Option<String>,
}

impl ConnectorOperation {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let state_raw: String = row.get("state")?;
        let state = ConnectorOperationState::parse(&state_raw).ok_or_else(|| {
            let index = row
                .as_ref()
                .column_index("state")
                .unwrap_or(usize::MAX);
            rusqlite::Error::InvalidColumnType(
                index,
                state_raw.clone(),
                rusqlite::types::Type::Text,
            )
        })?;
        Ok(Self {
            operation_id: row.get("operation_id")?,
            session_id: row.get("session_id")?,
            provider_id: row.get("provider_id")?,
            capability: row.get("capability")?,
            action: row.get("action")?,
            preview_sha256: row.get("preview_sha256")?,
            request_payload_hash: row.get("request_payload_hash")?,
            idempotency_key: row.get("idempotency_key")?,
            state,
            external_operation_id: row.get("external_operation_id")?,
            account_id: row.get("account_id")?,
            capability_fingerprint: row.get("capability_fingerprint")?,
            preview_json: row.get("preview_json")?,
            expires_at_ms: row.get("expires_at_ms")?,
            created_at: row.get("created_at")?,
            confirmed_at: row.get("confirmed_at")?,
            submitted_at: row.get("submitted_at")?,
            resolved_at: row.get("resolved_at")?,
            error: row.get("error")?,
            evidence_json: row.get("evidence_json")?,
        })
    }
}

/// 新建 draft 操作的写入参数。
#[derive(Debug, Clone)]
pub struct NewConnectorOperation {
    pub operation_id: String,
    pub session_id: String,
    pub provider_id: String,
    pub capability: Option<String>,
    pub action: String,
    pub preview_sha256: String,
    pub idempotency_key: String,
    pub account_id: Option<String>,
    pub capability_fingerprint: Option<String>,
    pub preview_json: String,
    pub expires_at_ms: Option<i64>,
    pub created_at: String,
}

/// Connector 操作账本 repo。所有状态迁移以单条原子 UPDATE 完成。
#[derive(Clone)]
pub struct ConnectorLedger {
    db: Arc<ChatV2Database>,
}

impl ConnectorLedger {
    pub fn new(db: Arc<ChatV2Database>) -> Self {
        Self { db }
    }

    /// draft 落库（操作生命周期的起点）。
    pub fn insert_draft(&self, op: &NewConnectorOperation) -> Result<(), String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO connector_operations (
                operation_id, session_id, provider_id, capability, action,
                preview_sha256, idempotency_key, state,
                account_id, capability_fingerprint,
                preview_json, expires_at_ms, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11, ?12)",
            params![
                op.operation_id,
                op.session_id,
                op.provider_id,
                op.capability,
                op.action,
                op.preview_sha256,
                op.idempotency_key,
                op.account_id,
                op.capability_fingerprint,
                op.preview_json,
                op.expires_at_ms,
                op.created_at,
            ],
        )
        .map_err(|e| format!("failed to insert connector operation: {}", e))?;
        Ok(())
    }

    /// 按主键读取。
    pub fn get(&self, operation_id: &str) -> Result<Option<ConnectorOperation>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM connector_operations WHERE operation_id = ?1",
            params![operation_id],
            ConnectorOperation::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read connector operation: {}", e))
    }

    /// 按系统幂等键读取（去重键：`session_id:idempotency_key`）。
    pub fn get_by_idempotency_key(
        &self,
        session_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<ConnectorOperation>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM connector_operations \
             WHERE session_id = ?1 AND idempotency_key = ?2",
            params![session_id, idempotency_key],
            ConnectorOperation::from_row,
        )
        .optional()
        .map_err(|e| format!("failed to read connector operation by idempotency key: {}", e))
    }

    /// 按会话查询（审计/对账视图；按创建时间升序）。
    pub fn list_by_session(&self, session_id: &str) -> Result<Vec<ConnectorOperation>, String> {
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM connector_operations \
                 WHERE session_id = ?1 ORDER BY created_at, operation_id",
            )
            .map_err(|e| format!("failed to prepare connector operation query: {}", e))?;
        let rows = stmt
            .query_map(params![session_id], ConnectorOperation::from_row)
            .map_err(|e| format!("failed to list connector operations: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("failed to parse connector operation: {}", e))?);
        }
        Ok(out)
    }

    /// `draft → confirmed`：前驱与 preview 哈希双重守卫（确认绑定的是原 draft）。
    pub fn mark_confirmed(
        &self,
        operation_id: &str,
        preview_sha256: &str,
        confirmed_at: &str,
    ) -> Result<(), String> {
        let to = ConnectorOperationState::Confirmed;
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "UPDATE connector_operations \
             SET state = ?2, confirmed_at = ?3 \
             WHERE operation_id = ?1 AND preview_sha256 = ?4 AND state IN ({})",
            ConnectorOperationState::predecessors_sql(to)
        );
        let changed = conn
            .execute(&sql, params![operation_id, to.as_str(), confirmed_at, preview_sha256])
            .map_err(|e| format!("failed to confirm connector operation: {}", e))?;
        if changed == 0 {
            return Err(
                "connector operation is not a confirmable draft or preview hash mismatch"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// `confirmed → submitting`：**必须先于 provider 调用成功落库**。
    /// `request_payload_hash` 记录实际发往 provider 的参数哈希（P2 对账用）。
    pub fn mark_submitting(
        &self,
        operation_id: &str,
        submitted_at: &str,
        request_payload_hash: &str,
    ) -> Result<(), String> {
        let to = ConnectorOperationState::Submitting;
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "UPDATE connector_operations \
             SET state = ?2, submitted_at = ?3, request_payload_hash = ?4 \
             WHERE operation_id = ?1 AND state IN ({})",
            ConnectorOperationState::predecessors_sql(to)
        );
        let changed = conn
            .execute(
                &sql,
                params![operation_id, to.as_str(), submitted_at, request_payload_hash],
            )
            .map_err(|e| format!("failed to mark connector operation submitting: {}", e))?;
        if changed == 0 {
            return Err("connector operation is not in a submittable state".to_string());
        }
        Ok(())
    }

    /// `submitting → committed`（`outcome_unknown → committed` 为 P2 核销预留）。
    pub fn mark_committed(
        &self,
        operation_id: &str,
        resolved_at: &str,
        external_operation_id: Option<&str>,
        evidence_json: &str,
    ) -> Result<(), String> {
        let to = ConnectorOperationState::Committed;
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "UPDATE connector_operations \
             SET state = ?2, resolved_at = ?3, external_operation_id = ?4, \
                 evidence_json = ?5, error = NULL \
             WHERE operation_id = ?1 AND state IN ({})",
            ConnectorOperationState::predecessors_sql(to)
        );
        let changed = conn
            .execute(
                &sql,
                params![
                    operation_id,
                    to.as_str(),
                    resolved_at,
                    external_operation_id,
                    evidence_json
                ],
            )
            .map_err(|e| format!("failed to mark connector operation committed: {}", e))?;
        if changed == 0 {
            return Err("connector operation is not in a committable state".to_string());
        }
        Ok(())
    }

    /// `submitting → failed`（`outcome_unknown → failed` 为 P2 核销预留）。
    pub fn mark_failed(
        &self,
        operation_id: &str,
        resolved_at: &str,
        error: &str,
    ) -> Result<(), String> {
        let to = ConnectorOperationState::Failed;
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "UPDATE connector_operations \
             SET state = ?2, resolved_at = ?3, error = ?4 \
             WHERE operation_id = ?1 AND state IN ({})",
            ConnectorOperationState::predecessors_sql(to)
        );
        let changed = conn
            .execute(&sql, params![operation_id, to.as_str(), resolved_at, error])
            .map_err(|e| format!("failed to mark connector operation failed: {}", e))?;
        if changed == 0 {
            return Err("connector operation is not in a failable state".to_string());
        }
        Ok(())
    }

    /// 启动对账：遗留 `submitting` → `outcome_unknown`，返回收敛行数。
    ///
    /// 进程在 provider 调用期间退出时，无法区分"远端已执行但响应丢失"与
    /// "远端未执行"——统一标记为 outcome_unknown，禁止自动重试（重复执行
    /// 比标记未知更危险），由 P2 的 provider lookup 进一步核销。
    pub fn reconcile_submitting_on_startup(&self) -> Result<usize, String> {
        let to = ConnectorOperationState::OutcomeUnknown;
        let conn = self.db.get_conn().map_err(|e| e.to_string())?;
        let sql = format!(
            "UPDATE connector_operations SET state = ?1 WHERE state IN ({})",
            ConnectorOperationState::predecessors_sql(to)
        );
        let changed = conn
            .execute(&sql, params![to.as_str()])
            .map_err(|e| format!("failed to reconcile connector operations: {}", e))?;
        Ok(changed)
    }
}

/// 启动恢复入口（G04-P0）：供应用启动路径挂载。
///
/// 本阶段仅做 submitting → outcome_unknown 收敛；P2 将在此之后接
/// provider lookup，把 outcome_unknown 核销为 committed/failed。
pub fn reconcile_on_startup(db: &Arc<ChatV2Database>) -> Result<usize, String> {
    ConnectorLedger::new(db.clone()).reconcile_submitting_on_startup()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use tempfile::TempDir;

    /// 创建已应用全部 chat_v2 迁移的测试库（生产一致的迁移路径：
    /// MigrationCoordinator → refinery embed_migrations!，含本模块对应的
    /// V20260907 connector_operations 表）。
    fn setup_test_db() -> (TempDir, Arc<ChatV2Database>) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).expect("Failed to create database");
        (temp_dir, Arc::new(db))
    }

    fn draft_op(operation_id: &str, session_id: &str) -> NewConnectorOperation {
        let preview_sha256 = "a".repeat(64);
        NewConnectorOperation {
            operation_id: operation_id.to_string(),
            session_id: session_id.to_string(),
            provider_id: "google-work".to_string(),
            capability: Some("mail".to_string()),
            action: "send".to_string(),
            idempotency_key: system_idempotency_key(operation_id, &preview_sha256),
            preview_sha256,
            account_id: Some("acct-1".to_string()),
            capability_fingerprint: Some("f".repeat(64)),
            preview_json: r#"{"provider_id":"google-work"}"#.to_string(),
            expires_at_ms: Some(4_000_000_000_000),
            created_at: "2026-09-07T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn g04_migration_creates_connector_operations_table() {
        let (_dir, db) = setup_test_db();
        let conn = db.get_conn().expect("conn");
        let table: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name = 'connector_operations'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query sqlite_master");
        assert_eq!(table.as_deref(), Some("connector_operations"));
        for index in [
            "idx_connector_operations_state",
            "idx_connector_operations_created_at",
            "idx_connector_operations_session_created",
            "idx_connector_operations_idempotency",
        ] {
            let found: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    params![index],
                    |row| row.get(0),
                )
                .optional()
                .expect("query index");
            assert_eq!(found.as_deref(), Some(index), "missing index {}", index);
        }
    }

    #[test]
    fn g04_system_idempotency_key_is_deterministic_and_binding() {
        let key_a = system_idempotency_key("op-1", &"a".repeat(64));
        let key_b = system_idempotency_key("op-1", &"a".repeat(64));
        assert_eq!(key_a, key_b, "same operation must derive the same key");
        assert_eq!(key_a.len(), 64, "sha256 hex");
        assert_ne!(
            key_a,
            system_idempotency_key("op-2", &"a".repeat(64)),
            "key must bind operation_id"
        );
        assert_ne!(
            key_a,
            system_idempotency_key("op-1", &"b".repeat(64)),
            "key must bind preview_sha256"
        );
    }

    #[test]
    fn g04_insert_and_read_roundtrip() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db);
        ledger.insert_draft(&draft_op("op-1", "session-a")).unwrap();

        let row = ledger.get("op-1").unwrap().expect("row exists");
        assert_eq!(row.state, ConnectorOperationState::Draft);
        assert_eq!(row.provider_id, "google-work");
        assert_eq!(row.capability.as_deref(), Some("mail"));
        assert_eq!(
            row.idempotency_key,
            system_idempotency_key("op-1", &"a".repeat(64))
        );
        assert!(row.confirmed_at.is_none() && row.submitted_at.is_none());

        let by_key = ledger
            .get_by_idempotency_key("session-a", &row.idempotency_key)
            .unwrap()
            .expect("lookup by idempotency key");
        assert_eq!(by_key.operation_id, "op-1");
        assert!(
            ledger
                .get_by_idempotency_key("session-b", &row.idempotency_key)
                .unwrap()
                .is_none(),
            "idempotency key is scoped by session"
        );

        let listed = ledger.list_by_session("session-a").unwrap();
        assert_eq!(listed.len(), 1);
        assert!(ledger.list_by_session("session-b").unwrap().is_empty());
    }

    #[test]
    fn g04_state_machine_legal_chain() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db);
        ledger.insert_draft(&draft_op("op-1", "session-a")).unwrap();

        ledger
            .mark_confirmed("op-1", &"a".repeat(64), "2026-09-07T00:01:00Z")
            .unwrap();
        assert_eq!(
            ledger.get("op-1").unwrap().unwrap().state,
            ConnectorOperationState::Confirmed
        );

        ledger
            .mark_submitting("op-1", "2026-09-07T00:02:00Z", "payload-hash")
            .unwrap();
        let row = ledger.get("op-1").unwrap().unwrap();
        assert_eq!(row.state, ConnectorOperationState::Submitting);
        assert_eq!(row.request_payload_hash.as_deref(), Some("payload-hash"));
        assert_eq!(row.submitted_at.as_deref(), Some("2026-09-07T00:02:00Z"));

        ledger
            .mark_committed(
                "op-1",
                "2026-09-07T00:03:00Z",
                Some("msg-1"),
                r#"{"success":true}"#,
            )
            .unwrap();
        let row = ledger.get("op-1").unwrap().unwrap();
        assert_eq!(row.state, ConnectorOperationState::Committed);
        assert_eq!(row.external_operation_id.as_deref(), Some("msg-1"));
        assert_eq!(row.resolved_at.as_deref(), Some("2026-09-07T00:03:00Z"));
        assert_eq!(row.evidence_json.as_deref(), Some(r#"{"success":true}"#));
    }

    #[test]
    fn g04_state_machine_rejects_illegal_transitions() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db);
        ledger.insert_draft(&draft_op("op-1", "session-a")).unwrap();

        // draft 不能跳过 confirmed 直接 submitting/committed/failed
        assert!(ledger.mark_submitting("op-1", "t", "h").is_err());
        assert!(ledger.mark_committed("op-1", "t", None, "{}").is_err());
        assert!(ledger.mark_failed("op-1", "t", "boom").is_err());
        // 确认时 preview 哈希必须匹配
        assert!(ledger.mark_confirmed("op-1", &"b".repeat(64), "t").is_err());
        assert_eq!(
            ledger.get("op-1").unwrap().unwrap().state,
            ConnectorOperationState::Draft,
            "illegal transitions must not move the state"
        );

        ledger.mark_confirmed("op-1", &"a".repeat(64), "t1").unwrap();
        // 重复确认被拒绝（无自环）
        assert!(ledger.mark_confirmed("op-1", &"a".repeat(64), "t2").is_err());
        // confirmed 不能回退或直接 committed
        assert!(ledger.mark_committed("op-1", "t", None, "{}").is_err());

        ledger.mark_submitting("op-1", "t2", "h").unwrap();
        // 重复 submit 被拒绝
        assert!(ledger.mark_submitting("op-1", "t3", "h").is_err());

        ledger.mark_committed("op-1", "t4", None, "{}").unwrap();
        // 终态不允许任何外向转换
        assert!(ledger.mark_failed("op-1", "t5", "boom").is_err());
        assert!(ledger.mark_submitting("op-1", "t6", "h").is_err());
        assert_eq!(
            ledger.get("op-1").unwrap().unwrap().state,
            ConnectorOperationState::Committed
        );
    }

    #[test]
    fn g04_failed_is_terminal() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db);
        ledger.insert_draft(&draft_op("op-1", "session-a")).unwrap();
        ledger.mark_confirmed("op-1", &"a".repeat(64), "t1").unwrap();
        ledger.mark_submitting("op-1", "t2", "h").unwrap();
        ledger.mark_failed("op-1", "t3", "provider boom").unwrap();

        let row = ledger.get("op-1").unwrap().unwrap();
        assert_eq!(row.state, ConnectorOperationState::Failed);
        assert_eq!(row.error.as_deref(), Some("provider boom"));
        assert!(ledger.mark_submitting("op-1", "t4", "h").is_err());
        assert!(ledger.mark_committed("op-1", "t5", None, "{}").is_err());
    }

    #[test]
    fn g04_reconcile_converts_submitting_to_outcome_unknown() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db.clone());

        // 三个操作：分别停在 draft / submitting / committed
        ledger.insert_draft(&draft_op("op-draft", "session-a")).unwrap();

        ledger
            .insert_draft(&draft_op("op-submitting", "session-a"))
            .unwrap();
        ledger
            .mark_confirmed("op-submitting", &"a".repeat(64), "t1")
            .unwrap();
        ledger
            .mark_submitting("op-submitting", "t2", "h")
            .unwrap();

        ledger
            .insert_draft(&draft_op("op-committed", "session-a"))
            .unwrap();
        ledger
            .mark_confirmed("op-committed", &"a".repeat(64), "t1")
            .unwrap();
        ledger.mark_submitting("op-committed", "t2", "h").unwrap();
        ledger
            .mark_committed("op-committed", "t3", Some("ext-1"), "{}")
            .unwrap();

        // 模拟进程重启：submitting 收敛为 outcome_unknown，其余状态不动
        let reconciled = reconcile_on_startup(&db).unwrap();
        assert_eq!(reconciled, 1);
        assert_eq!(
            ledger.get("op-draft").unwrap().unwrap().state,
            ConnectorOperationState::Draft
        );
        assert_eq!(
            ledger.get("op-submitting").unwrap().unwrap().state,
            ConnectorOperationState::OutcomeUnknown
        );
        assert_eq!(
            ledger.get("op-committed").unwrap().unwrap().state,
            ConnectorOperationState::Committed
        );

        // 幂等：再次对账无行可收敛
        assert_eq!(reconcile_on_startup(&db).unwrap(), 0);
    }

    #[test]
    fn g04_outcome_unknown_is_not_committable_in_p0() {
        let (_dir, db) = setup_test_db();
        let ledger = ConnectorLedger::new(db.clone());
        ledger.insert_draft(&draft_op("op-1", "session-a")).unwrap();
        ledger.mark_confirmed("op-1", &"a".repeat(64), "t1").unwrap();
        ledger.mark_submitting("op-1", "t2", "h").unwrap();
        assert_eq!(reconcile_on_startup(&db).unwrap(), 1);

        // P0：outcome_unknown 禁止自动重试（不能再次 submitting）
        assert!(ledger.mark_submitting("op-1", "t3", "h").is_err());
        // P2 预留：can_transition 允许 outcome_unknown → committed/failed
        assert!(ConnectorOperationState::can_transition(
            ConnectorOperationState::OutcomeUnknown,
            ConnectorOperationState::Committed
        ));
        assert!(ConnectorOperationState::can_transition(
            ConnectorOperationState::OutcomeUnknown,
            ConnectorOperationState::Failed
        ));
    }
}
