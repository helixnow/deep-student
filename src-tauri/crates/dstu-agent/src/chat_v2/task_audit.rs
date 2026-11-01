//! Deterministic, export-safe audit manifests for agent task outcomes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::environment_manifest::EnvironmentManifest;
use super::task_objects::TaskObjectHandle;

pub const TASK_AUDIT_SCHEMA_VERSION: u16 = 1;
const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditToolCall {
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditApproval {
    pub approval_id: String,
    pub scope_hash: String,
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditOutput {
    pub object_handle_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuditTarget {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipients: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acl_principals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeCoverage {
    pub changes_recorded: bool,
    pub rollback_available: bool,
    pub rollback_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskAuditManifest {
    pub schema_version: u16,
    pub task_id: String,
    pub evidence_origin: String,
    pub authoritative: bool,
    pub object_handles: Vec<TaskObjectHandle>,
    pub tool_calls: Vec<AuditToolCall>,
    pub approvals: Vec<AuditApproval>,
    pub outputs: Vec<AuditOutput>,
    pub connector_targets: Vec<ConnectorAuditTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_pack_version: Option<String>,
    /// G08：任务环境清单全文（environment_manifest.rs 采集快照）。
    /// 留在 audit JSON 内（侵入最小，不落新表），重放/复验时作 baseline。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_manifest: Option<EnvironmentManifest>,
    /// G08：环境清单内容指纹（`EnvironmentManifest::content_fingerprint`），
    /// 与全文同源生成，供快速比对/列表展示，不必 parse 全文。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_manifest_hash: Option<String>,
    pub change_coverage: ChangeCoverage,
    pub coverage_complete: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_coverage: Vec<String>,
}

#[derive(Debug, Default)]
pub struct TaskAuditManifestBuilder {
    task_id: String,
    object_handles: BTreeMap<String, TaskObjectHandle>,
    tool_calls: BTreeMap<String, AuditToolCall>,
    approvals: BTreeMap<String, AuditApproval>,
    outputs: BTreeMap<String, AuditOutput>,
    connector_targets: BTreeMap<String, ConnectorAuditTarget>,
    role_pack_version: Option<String>,
    environment_manifest: Option<EnvironmentManifest>,
    change_coverage: ChangeCoverage,
    backend_ledger_verified: bool,
}

impl TaskAuditManifestBuilder {
    pub fn new(task_id: impl Into<String>) -> Self {
        Self {
            task_id: task_id.into(),
            ..Self::default()
        }
    }

    pub fn add_object_handle(&mut self, handle: TaskObjectHandle) -> Result<&mut Self, String> {
        handle.validate()?;
        self.object_handles.insert(handle.handle_id.clone(), handle);
        Ok(self)
    }

    pub fn add_tool_call(&mut self, call: AuditToolCall) -> &mut Self {
        self.tool_calls.insert(call.call_id.clone(), call);
        self
    }

    pub fn add_approval(&mut self, approval: AuditApproval) -> &mut Self {
        self.approvals
            .insert(approval.approval_id.clone(), approval);
        self
    }

    pub fn add_output(&mut self, output: AuditOutput) -> &mut Self {
        self.outputs.insert(output.object_handle_id.clone(), output);
        self
    }

    pub fn add_connector_target(&mut self, target: ConnectorAuditTarget) -> &mut Self {
        self.connector_targets
            .insert(target.operation_id.clone(), target);
        self
    }

    pub fn role_pack_version(&mut self, version: impl Into<String>) -> &mut Self {
        self.role_pack_version = Some(version.into());
        self
    }

    /// G08：挂接任务开始时采集的环境清单（environment_manifest.rs）。
    ///
    /// 全文与内容指纹同源记录（build 时指纹由清单算出，保证两者一致）。
    /// 环境清单是上下文元数据，不参与 coverage/authoritative 判定。
    pub fn environment_manifest(&mut self, manifest: EnvironmentManifest) -> &mut Self {
        self.environment_manifest = Some(manifest);
        self
    }

    pub fn change_coverage(&mut self, coverage: ChangeCoverage) -> &mut Self {
        self.change_coverage = coverage;
        self
    }

    /// Mark the manifest as cross-checked against the backend session ledger
    /// (ChatV2 blocks + approval records).
    ///
    /// Only backend code paths that actually perform that verification may
    /// call this. The tool-facing `task_audit_export` executor never does, so
    /// LLM/caller-supplied manifests stay non-authoritative (fail-closed
    /// default). When set and no other coverage is missing, the built
    /// manifest reports `evidence_origin = "backend_verified"` and
    /// `authoritative = true`.
    pub fn verified_against_backend_session_ledger(&mut self) -> &mut Self {
        self.backend_ledger_verified = true;
        self
    }

    pub fn build(self) -> Result<TaskAuditManifest, String> {
        if self.task_id.trim().is_empty() {
            return Err("task_id is required".to_string());
        }

        let mut missing = Vec::new();
        if self.object_handles.is_empty() {
            missing.push("object_handles".to_string());
        }
        if self.tool_calls.is_empty() {
            missing.push("tool_calls".to_string());
        }
        if !self.change_coverage.changes_recorded {
            missing.push("change_receipts".to_string());
        }
        if self.change_coverage.rollback_available && !self.change_coverage.rollback_verified {
            missing.push("rollback_verification".to_string());
        }
        // By default this builder aggregates caller-supplied evidence and must
        // never claim to be an authoritative session audit package. Only an
        // explicit backend cross-check (`verified_against_backend_session_ledger`)
        // removes the hole and can make the manifest authoritative.
        if !self.backend_ledger_verified {
            missing.push("backend_session_ledger".to_string());
        }

        let coverage_complete = missing.is_empty();
        let environment_manifest_hash = self
            .environment_manifest
            .as_ref()
            .map(EnvironmentManifest::content_fingerprint);
        Ok(TaskAuditManifest {
            schema_version: TASK_AUDIT_SCHEMA_VERSION,
            task_id: self.task_id,
            evidence_origin: if self.backend_ledger_verified {
                "backend_verified".to_string()
            } else {
                "caller_supplied".to_string()
            },
            authoritative: self.backend_ledger_verified && coverage_complete,
            object_handles: self.object_handles.into_values().collect(),
            tool_calls: self.tool_calls.into_values().collect(),
            approvals: self.approvals.into_values().collect(),
            outputs: self.outputs.into_values().collect(),
            connector_targets: self.connector_targets.into_values().collect(),
            role_pack_version: self.role_pack_version,
            environment_manifest: self.environment_manifest,
            environment_manifest_hash,
            change_coverage: self.change_coverage,
            coverage_complete,
            missing_coverage: missing,
        })
    }
}

impl TaskAuditManifest {
    /// Produces the only representation suitable for user-visible export.
    pub fn export_value(&self) -> Result<Value, String> {
        let mut value = serde_json::to_value(self).map_err(|error| error.to_string())?;
        redact_secrets(&mut value);
        Ok(value)
    }
}

pub fn redact_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_secret_key(key) {
                    *child = Value::String(REDACTED.to_string());
                } else {
                    redact_secrets(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_secrets),
        Value::String(text) => {
            if let Some(redacted) = redact_url_secrets(text) {
                *text = redacted;
            }
        }
        _ => {}
    }
}

fn redact_url_secrets(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    let pairs = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let has_secret_query = pairs.iter().any(|(key, _)| is_secret_key(key));
    let has_password = url.password().is_some();
    if !has_secret_query && !has_password {
        return None;
    }
    if has_password {
        let _ = url.set_password(Some(REDACTED));
    }
    if has_secret_query {
        url.query_pairs_mut()
            .clear()
            .extend_pairs(pairs.iter().map(|(key, value)| {
                (
                    key.as_str(),
                    if is_secret_key(key) { REDACTED } else { value },
                )
            }));
    }
    Some(url.into())
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "apikey"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "password"
            | "secret"
            | "clientsecret"
            | "cookie"
            | "setcookie"
    ) || normalized.ends_with("token")
        || normalized.ends_with("secret")
        || normalized.ends_with("password")
        || normalized.ends_with("apikey")
        || normalized.ends_with("authorization")
        || normalized.ends_with("cookie")
        || normalized.ends_with("privatekey")
        || normalized.ends_with("credential")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::environment_manifest::CaptureInputs;

    /// G08：环境清单挂进审计记录——全文内嵌 + 指纹同源，且不影响
    /// coverage/authoritative 判定（环境清单是上下文元数据，非覆盖项）。
    #[test]
    fn g08_environment_manifest_is_embedded_with_matching_hash() {
        let env_manifest = EnvironmentManifest::capture(&CaptureInputs {
            model_id: Some("deepseek-chat".to_string()),
            ..CaptureInputs::default()
        });
        let expected_hash = env_manifest.content_fingerprint();

        let mut builder = TaskAuditManifestBuilder::new("task-env-1");
        builder
            .add_tool_call(AuditToolCall {
                call_id: "call-1".into(),
                tool_name: "example".into(),
                arguments: Value::Null,
                result_hash: None,
            })
            .environment_manifest(env_manifest.clone());
        let manifest = builder.build().unwrap();

        assert_eq!(manifest.environment_manifest, Some(env_manifest));
        assert_eq!(
            manifest.environment_manifest_hash.as_deref(),
            Some(expected_hash.as_str())
        );
        // 环境清单不补齐任何 coverage 缺口（仍 fail-closed）
        assert!(!manifest.coverage_complete);
        assert!(!manifest.authoritative);

        // 序列化键名 camelCase，且 export 重放逐字段稳定
        let value = manifest.export_value().unwrap();
        assert!(value.get("environmentManifest").is_some());
        assert_eq!(
            value["environmentManifestHash"].as_str(),
            Some(expected_hash.as_str())
        );
        assert!(value["environmentManifest"].get("toolSchemaHash").is_some());

        // 未挂环境清单时两字段均缺席（skip_serializing_if）
        let mut plain = TaskAuditManifestBuilder::new("task-env-0");
        plain.add_tool_call(AuditToolCall {
            call_id: "call-1".into(),
            tool_name: "example".into(),
            arguments: Value::Null,
            result_hash: None,
        });
        let value = plain.build().unwrap().export_value().unwrap();
        assert!(value.get("environmentManifest").is_none());
        assert!(value.get("environmentManifestHash").is_none());
    }

    #[test]
    fn secx_01_export_recursively_redacts_secret_values() {
        let mut value = serde_json::json!({
            "authorization": "Bearer abc",
            "nested": [{"apiKey": "key", "safe": "visible"}],
            "refresh_token": "refresh",
            "sessionToken": "session",
            "sourceUri": "https://user:password@example.test/file?token=secret&visible=yes"
        });
        redact_secrets(&mut value);
        assert_eq!(value["authorization"], REDACTED);
        assert_eq!(value["nested"][0]["apiKey"], REDACTED);
        assert_eq!(value["refresh_token"], REDACTED);
        assert_eq!(value["sessionToken"], REDACTED);
        assert_eq!(value["nested"][0]["safe"], "visible");
        let redacted_uri = value["sourceUri"].as_str().unwrap();
        assert!(!redacted_uri.contains("password"));
        assert!(!redacted_uri.contains("token=secret"));
        assert!(redacted_uri.contains("visible=yes"));
    }

    #[test]
    fn col_06_incomplete_coverage_is_never_reported_complete() {
        let mut builder = TaskAuditManifestBuilder::new("task-1");
        builder.add_tool_call(AuditToolCall {
            call_id: "call-1".into(),
            tool_name: "example".into(),
            arguments: Value::Null,
            result_hash: None,
        });
        let manifest = builder.build().unwrap();
        assert!(!manifest.coverage_complete);
        assert!(manifest.missing_coverage.contains(&"object_handles".into()));
        assert!(manifest
            .missing_coverage
            .contains(&"change_receipts".into()));
    }

    #[test]
    fn col_08_rollback_claim_requires_verification() {
        let mut builder = TaskAuditManifestBuilder::new("task-1");
        builder.change_coverage(ChangeCoverage {
            changes_recorded: true,
            rollback_available: true,
            rollback_verified: false,
        });
        let manifest = builder.build().unwrap();
        assert!(!manifest.coverage_complete);
        assert!(manifest
            .missing_coverage
            .contains(&"rollback_verification".into()));
    }

    #[test]
    fn col_08_caller_supplied_manifest_is_never_authoritative() {
        let mut builder = TaskAuditManifestBuilder::new("task-1");
        builder
            .add_object_handle(TaskObjectHandle {
                schema_version: 1,
                handle_id: "input-1".into(),
                kind: crate::chat_v2::task_objects::TaskObjectKind::File,
                display_name: "input.txt".into(),
                media_type: None,
                size_bytes: None,
                sha256: None,
                locator: None,
                provider_ref: None,
                acl: None,
                capabilities: Default::default(),
                expires_at: None,
                provenance: crate::chat_v2::task_objects::ObjectProvenance {
                    source: "caller".into(),
                    source_uri: None,
                    server: None,
                    tool: None,
                    derived_from: Vec::new(),
                    observed_at: "2026-07-19T00:00:00Z".into(),
                },
            })
            .unwrap()
            .add_tool_call(AuditToolCall {
                call_id: "call-1".into(),
                tool_name: "example".into(),
                arguments: Value::Null,
                result_hash: None,
            })
            .change_coverage(ChangeCoverage {
                changes_recorded: true,
                rollback_available: false,
                rollback_verified: false,
            });
        let manifest = builder.build().unwrap();
        assert!(!manifest.authoritative);
        assert_eq!(manifest.evidence_origin, "caller_supplied");
        assert!(!manifest.coverage_complete);
        assert!(manifest
            .missing_coverage
            .contains(&"backend_session_ledger".to_string()));
    }

    /// 分区 J 第二轮：显式后端 ledger 交叉校验后，且其余覆盖完整时，
    /// 清单才可宣称权威；缺任何覆盖仍然 fail-closed。
    #[test]
    fn backend_verified_manifest_becomes_authoritative_only_with_full_coverage() {
        let mut builder = TaskAuditManifestBuilder::new("task-1");
        builder
            .add_object_handle(TaskObjectHandle {
                schema_version: 1,
                handle_id: "input-1".into(),
                kind: crate::chat_v2::task_objects::TaskObjectKind::File,
                display_name: "input.txt".into(),
                media_type: None,
                size_bytes: None,
                sha256: None,
                locator: None,
                provider_ref: None,
                acl: None,
                capabilities: Default::default(),
                expires_at: None,
                provenance: crate::chat_v2::task_objects::ObjectProvenance {
                    source: "backend".into(),
                    source_uri: None,
                    server: None,
                    tool: None,
                    derived_from: Vec::new(),
                    observed_at: "2026-07-19T00:00:00Z".into(),
                },
            })
            .unwrap()
            .add_tool_call(AuditToolCall {
                call_id: "call-1".into(),
                tool_name: "example".into(),
                arguments: Value::Null,
                result_hash: None,
            })
            .change_coverage(ChangeCoverage {
                changes_recorded: true,
                rollback_available: false,
                rollback_verified: false,
            })
            .verified_against_backend_session_ledger();
        let manifest = builder.build().unwrap();
        assert!(manifest.authoritative);
        assert_eq!(manifest.evidence_origin, "backend_verified");
        assert!(manifest.coverage_complete);
        assert!(manifest.missing_coverage.is_empty());

        // 校验位存在但覆盖缺失 → 仍不权威
        let mut incomplete = TaskAuditManifestBuilder::new("task-2");
        incomplete.verified_against_backend_session_ledger();
        let manifest = incomplete.build().unwrap();
        assert!(!manifest.authoritative);
        assert!(!manifest.coverage_complete);
        assert!(!manifest
            .missing_coverage
            .contains(&"backend_session_ledger".to_string()));
    }
}
