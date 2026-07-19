//! Session-level Ask / Plan / Craft authority gate.
//!
//! Evaluated in `tool_loop` after effective sensitivity is resolved and before
//! `ApprovalManager`. Headless / sub-agent paths share the same gate because they
//! all execute tools through `tool_loop`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::chat_v2::tools::ToolSensitivity;
use crate::chat_v2::types::{AuthorityMode, SessionAuthorityState};

/// Meta tools treated as read even if an executor reports Medium/High.
pub const META_TOOL_WHITELIST: &[&str] = &[
    "attempt_completion",
    "todo_init",
    "todo_update",
    "todo_add",
    "todo_get",
    "load_skills",
    "ask_user",
];

/// Default plan batch validity after user approval.
const DEFAULT_PLAN_APPROVED_TTL_SECS: i64 = 30 * 60;

/// Canonical short tool name (strips builtin-/builtin:/mcp prefixes).
pub fn canonical_tool_name(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("builtin-")
        .or_else(|| tool_name.strip_prefix("builtin:"))
        .or_else(|| tool_name.strip_prefix("mcp.tools."))
        .or_else(|| tool_name.strip_prefix("mcp_"))
        .unwrap_or(tool_name)
}

/// Whether this tool is an always-read meta tool.
pub fn is_meta_read_tool(tool_name: &str) -> bool {
    let short = canonical_tool_name(tool_name);
    META_TOOL_WHITELIST.contains(&short) || short.starts_with("todo_")
}

/// Write = effective Medium/High and not a meta read tool.
pub fn is_write_tool(tool_name: &str, effective_sensitivity: Option<ToolSensitivity>) -> bool {
    if is_meta_read_tool(tool_name) {
        return false;
    }
    match effective_sensitivity {
        Some(ToolSensitivity::Low) => false,
        Some(ToolSensitivity::Medium) | Some(ToolSensitivity::High) | None => true,
    }
}

/// Gate decision before ApprovalManager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorityGateDecision {
    /// Continue to ApprovalManager / executor.
    Allow,
    /// Ask mode hard block — feed structured rejection to the model.
    BlockAsk { message: String, tool_name: String },
    /// Plan mode: no active approved batch — wait for plan_gate.
    WaitPlanGate { summary: String },
}

pub fn evaluate_authority_gate(
    state: &SessionAuthorityState,
    tool_name: &str,
    effective_sensitivity: Option<ToolSensitivity>,
    binding_key: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> AuthorityGateDecision {
    let is_write = is_write_tool(tool_name, effective_sensitivity);
    if !is_write {
        return AuthorityGateDecision::Allow;
    }

    match state.authority_mode {
        AuthorityMode::Craft => AuthorityGateDecision::Allow,
        AuthorityMode::Ask => AuthorityGateDecision::BlockAsk {
            tool_name: tool_name.to_string(),
            message: ask_block_message(tool_name),
        },
        AuthorityMode::Plan => {
            if binding_key.is_some_and(|key| {
                state
                    .plan
                    .as_ref()
                    .is_some_and(|plan| plan.is_active_for_binding(key, now))
            }) {
                AuthorityGateDecision::Allow
            } else {
                AuthorityGateDecision::WaitPlanGate {
                    summary: default_plan_summary(tool_name),
                }
            }
        }
    }
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&map[key]));
            }
            Value::Object(canonical)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

/// Opaque, deterministic binding for one Plan-mode call family in one model round.
pub fn plan_call_binding_key(tool_name: &str, arguments: &Value, round_id: Option<&str>) -> String {
    let payload = json!({
        "tool": canonical_tool_name(tool_name),
        "arguments": canonical_json(arguments),
        "roundId": round_id.unwrap_or(""),
    });
    let encoded = serde_json::to_vec(&payload).unwrap_or_default();
    format!("planbind:{:x}", Sha256::digest(encoded))
}

pub fn ask_block_message(tool_name: &str) -> String {
    format!(
        "AUTHORITY_BLOCKED: session is in Ask (问一问) mode. \
         Write tool '{}' was refused because only Low-sensitivity / meta tools may run. \
         Ask the user to switch to Plan (想一想) or Craft (做一做) mode, then retry. \
         suggestedMode=plan",
        tool_name
    )
}

pub fn ask_block_structured_output(tool_name: &str) -> Value {
    json!({
        "authorityBlocked": true,
        "authorityMode": "ask",
        "suggestedMode": "plan",
        "toolName": tool_name,
        "message": ask_block_message(tool_name),
    })
}

fn default_plan_summary(tool_name: &str) -> String {
    format!("Execute this exact `{tool_name}` call once")
}

pub fn default_plan_ttl_secs() -> i64 {
    DEFAULT_PLAN_APPROVED_TTL_SECS
}

/// Payload emitted on `plan_gate` events (blocking interaction).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGateRequest {
    pub session_id: String,
    pub plan_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub summary: String,
    pub timeout_seconds: u32,
    pub arguments: Value,
}

/// User response to a plan_gate wait.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGateResponse {
    pub session_id: String,
    pub plan_id: String,
    pub tool_call_id: String,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// In-process waiter for plan_gate (mirrors ApprovalManager oneshot pattern).
#[derive(Default)]
pub struct PlanGateManager {
    pending: Mutex<HashMap<String, (String, oneshot::Sender<PlanGateResponse>)>>,
    default_timeout: u32,
}

impl PlanGateManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            default_timeout: 60,
        }
    }

    pub fn with_timeout(mut self, timeout_seconds: u32) -> Self {
        self.default_timeout = timeout_seconds;
        self
    }

    pub fn default_timeout(&self) -> u32 {
        self.default_timeout
    }

    fn pending_key(session_id: &str, tool_call_id: &str) -> String {
        format!("{session_id}\n{tool_call_id}")
    }

    pub fn register(
        &self,
        session_id: &str,
        tool_call_id: &str,
        plan_id: &str,
    ) -> oneshot::Receiver<PlanGateResponse> {
        let (tx, rx) = oneshot::channel();
        let key = Self::pending_key(session_id, tool_call_id);
        let mut map = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((_, old)) = map.insert(key, (plan_id.to_string(), tx)) {
            let _ = old.send(PlanGateResponse {
                session_id: session_id.to_string(),
                plan_id: String::new(),
                tool_call_id: tool_call_id.to_string(),
                approved: false,
                reason: Some("superseded".to_string()),
            });
        }
        rx
    }

    pub fn respond(&self, response: PlanGateResponse) -> bool {
        let key = Self::pending_key(&response.session_id, &response.tool_call_id);
        let mut map = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let Some((expected_plan_id, _)) = map.get(&key) else {
            return false;
        };
        if expected_plan_id != &response.plan_id {
            return false;
        }
        let (_, tx) = map.remove(&key).expect("pending plan existed");
        tx.send(response).is_ok()
    }

    pub fn cancel(&self, session_id: &str, tool_call_id: &str) {
        let key = Self::pending_key(session_id, tool_call_id);
        let mut map = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(&key);
    }
}

pub fn global_plan_gate_manager() -> &'static PlanGateManager {
    static MANAGER: OnceLock<PlanGateManager> = OnceLock::new();
    MANAGER.get_or_init(PlanGateManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::PlanAuthorityState;
    use chrono::Duration as ChronoDuration;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn craft_allows_writes() {
        let state = SessionAuthorityState::craft_default();
        let decision = evaluate_authority_gate(
            &state,
            "builtin-note_delete",
            Some(ToolSensitivity::High),
            None,
            Utc::now(),
        );
        assert_eq!(decision, AuthorityGateDecision::Allow);
    }

    #[test]
    fn ask_blocks_medium_write_and_allows_low() {
        let state = SessionAuthorityState {
            authority_mode: AuthorityMode::Ask,
            plan: None,
        };
        let blocked = evaluate_authority_gate(
            &state,
            "builtin-memory_export_all",
            Some(ToolSensitivity::Medium),
            None,
            Utc::now(),
        );
        match blocked {
            AuthorityGateDecision::BlockAsk { message, .. } => {
                assert!(message.contains("AUTHORITY_BLOCKED"));
                assert!(message.contains("suggestedMode=plan"));
            }
            other => panic!("expected BlockAsk, got {other:?}"),
        }

        let allowed = evaluate_authority_gate(
            &state,
            "builtin-memory_search",
            Some(ToolSensitivity::Low),
            None,
            Utc::now(),
        );
        assert_eq!(allowed, AuthorityGateDecision::Allow);
    }

    #[test]
    fn meta_tools_are_never_writes() {
        for name in [
            "attempt_completion",
            "builtin-attempt_completion",
            "todo_update",
            "builtin-todo_init",
            "load_skills",
            "ask_user",
            "builtin-ask_user",
        ] {
            assert!(
                !is_write_tool(name, Some(ToolSensitivity::High)),
                "{name} must be meta-read"
            );
        }
    }

    #[test]
    fn plan_waits_without_approval_then_allows_active_batch() {
        let mut state = SessionAuthorityState {
            authority_mode: AuthorityMode::Plan,
            plan: None,
        };
        let now = Utc::now();
        assert!(matches!(
            evaluate_authority_gate(
                &state,
                "builtin-note_delete",
                Some(ToolSensitivity::High),
                None,
                now
            ),
            AuthorityGateDecision::WaitPlanGate { .. }
        ));

        let mut plan = PlanAuthorityState::new_pending("delete notes");
        let binding = plan_call_binding_key("builtin-note_delete", &json!({"id": 1}), Some("r1"));
        plan.bind_to_call(binding.clone());
        plan.mark_approved(600);
        state.plan = Some(plan.clone());
        assert_eq!(
            evaluate_authority_gate(
                &state,
                "builtin-note_delete",
                Some(ToolSensitivity::High),
                Some(&binding),
                now
            ),
            AuthorityGateDecision::Allow
        );

        let mut expired = plan;
        expired.approved_until = Some((now - ChronoDuration::seconds(1)).to_rfc3339());
        state.plan = Some(expired);
        assert!(matches!(
            evaluate_authority_gate(
                &state,
                "builtin-note_delete",
                Some(ToolSensitivity::High),
                Some(&binding),
                now
            ),
            AuthorityGateDecision::WaitPlanGate { .. }
        ));
    }

    #[test]
    fn metadata_roundtrip_defaults_to_craft() {
        let state = SessionAuthorityState::from_metadata(None);
        assert_eq!(state.authority_mode, AuthorityMode::Craft);

        let with_ask = SessionAuthorityState {
            authority_mode: AuthorityMode::Ask,
            plan: None,
        };
        let meta = with_ask.apply_to_metadata(None);
        let loaded = SessionAuthorityState::from_metadata(Some(&meta));
        assert_eq!(loaded.authority_mode, AuthorityMode::Ask);

        let snake = json!({ "authority_mode": "plan" });
        assert_eq!(
            SessionAuthorityState::from_metadata(Some(&snake)).authority_mode,
            AuthorityMode::Plan
        );
    }

    /// Behaviour-level: counting executor must not run when Ask blocks a write.
    #[tokio::test]
    async fn ask_gate_prevents_executor_invocation() {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = SessionAuthorityState {
            authority_mode: AuthorityMode::Ask,
            plan: None,
        };
        let decision = evaluate_authority_gate(
            &state,
            "fake_write_tool",
            Some(ToolSensitivity::Medium),
            None,
            Utc::now(),
        );
        match decision {
            AuthorityGateDecision::BlockAsk { message, .. } => {
                assert_eq!(calls.load(Ordering::SeqCst), 0);
                assert!(message.contains("AUTHORITY_BLOCKED"));
                assert!(
                    ask_block_structured_output("fake_write_tool")["authorityBlocked"]
                        .as_bool()
                        .unwrap()
                );
            }
            AuthorityGateDecision::Allow => {
                calls.fetch_add(1, Ordering::SeqCst);
                panic!("Ask must not Allow writes");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn plan_gate_manager_delivers_approval() {
        let manager = PlanGateManager::new().with_timeout(5);
        let rx = manager.register("sess_1", "call_1", "plan_abc");
        assert!(manager.respond(PlanGateResponse {
            session_id: "sess_1".into(),
            plan_id: "plan_abc".into(),
            tool_call_id: "call_1".into(),
            approved: true,
            reason: None,
        }));
        let resp = rx.await.expect("response");
        assert!(resp.approved);
        assert_eq!(resp.plan_id, "plan_abc");
    }

    #[tokio::test]
    async fn plan_gate_manager_rejects_wrong_plan_id_without_consuming_waiter() {
        let manager = PlanGateManager::new().with_timeout(5);
        let rx = manager.register("sess_1", "call_1", "plan_expected");
        assert!(!manager.respond(PlanGateResponse {
            session_id: "sess_1".into(),
            plan_id: "plan_stale".into(),
            tool_call_id: "call_1".into(),
            approved: true,
            reason: None,
        }));
        assert!(manager.respond(PlanGateResponse {
            session_id: "sess_1".into(),
            plan_id: "plan_expected".into(),
            tool_call_id: "call_1".into(),
            approved: true,
            reason: None,
        }));
        assert_eq!(rx.await.unwrap().plan_id, "plan_expected");
    }

    #[test]
    fn plan_binding_is_canonical_and_round_scoped() {
        let a = plan_call_binding_key("builtin-note_delete", &json!({"b": 2, "a": 1}), Some("r1"));
        let b = plan_call_binding_key("note_delete", &json!({"a": 1, "b": 2}), Some("r1"));
        assert_eq!(a, b);
        assert_ne!(
            a,
            plan_call_binding_key("note_delete", &json!({"a": 1, "b": 2}), Some("r2"))
        );
    }
}
