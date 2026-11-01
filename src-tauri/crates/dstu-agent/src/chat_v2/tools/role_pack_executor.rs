//! Read-only role pack discovery, exact-version retrieval, and input validation.

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::role_packs::{
    find_role_pack, role_pack_registry, validate_role_pack_input, RolePack,
    ROLE_PACK_REGISTRY_REVISION,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const LIST: &str = "role_pack_list";
    pub const GET: &str = "role_pack_get";
    pub const VALIDATE: &str = "role_pack_validate";
}

pub struct RolePackExecutor;

impl RolePackExecutor {
    pub fn new() -> Self {
        Self
    }

    fn selected_pack(args: &Value) -> Result<&'static RolePack, String> {
        let pack_id = args
            .get("pack_id")
            .or_else(|| args.get("packId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "pack_id is required".to_string())?;
        let version = args
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        find_role_pack(pack_id, version).ok_or_else(|| match version {
            Some(version) => format!("Role pack '{pack_id}' version '{version}' was not found"),
            None => format!("Role pack '{pack_id}' was not found"),
        })
    }

    fn provenance(pack: &RolePack, ctx: &ExecutionContext, input: Option<&Value>) -> Value {
        let input_digest = input.map(|value| {
            let bytes = serde_json::to_vec(value).unwrap_or_default();
            hex::encode(Sha256::digest(bytes))
        });
        json!({
            "taskProvenance": {
                "rolePackId": pack.id,
                "rolePackVersion": pack.version,
                "selectionKey": format!("{}@{}", pack.id, pack.version),
                "registryRevision": ROLE_PACK_REGISTRY_REVISION,
                "sessionId": ctx.session_id,
                "messageId": ctx.message_id,
                "inputDigest": input_digest,
            },
            "auditManifest": {
                "schemaVersion": 1,
                "selectedRolePack": { "id": pack.id, "version": pack.version },
                "registryRevision": ROLE_PACK_REGISTRY_REVISION,
                "highRisk": pack.high_risk,
                "humanFinalReviewRequired": pack.human_final_review_required,
                "automatedFinalDecisionAllowed": false,
                "verificationGates": pack.verification_gates,
                "deliveryManifest": pack.delivery_manifest,
            }
        })
    }

    fn execute_read(
        &self,
        name: &str,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        match strip_tool_namespace(name) {
            tool_names::LIST => {
                let domain = args.get("domain").and_then(Value::as_str).map(str::trim);
                let include_deprecated = args
                    .get("include_deprecated")
                    .or_else(|| args.get("includeDeprecated"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let packs = role_pack_registry()
                    .iter()
                    .filter(|pack| match domain {
                        None => true,
                        Some(domain) => domain.is_empty() || pack.domain == domain,
                    })
                    .filter(|pack| include_deprecated || !pack.deprecated)
                    .map(|pack| json!({
                        "id": pack.id,
                        "domain": pack.domain,
                        "title": pack.title,
                        "version": pack.version,
                        "deprecated": pack.deprecated,
                        "highRisk": pack.high_risk,
                        "humanFinalReviewRequired": pack.human_final_review_required,
                        "workflowIds": pack.workflows.iter().map(|workflow| workflow.id.as_str()).collect::<Vec<_>>(),
                    }))
                    .collect::<Vec<_>>();
                Ok(json!({
                    "registryRevision": ROLE_PACK_REGISTRY_REVISION,
                    "versionSelection": "exact versions remain selectable; omit version only to select latest",
                    "packs": packs,
                }))
            }
            tool_names::GET => {
                let pack = Self::selected_pack(args)?;
                let mut output = json!({ "pack": pack });
                let provenance = Self::provenance(pack, ctx, None);
                if let (Some(output), Some(provenance)) =
                    (output.as_object_mut(), provenance.as_object())
                {
                    output.extend(provenance.clone());
                }
                Ok(output)
            }
            tool_names::VALIDATE => {
                let pack = Self::selected_pack(args)?;
                let inputs = args.get("inputs").cloned().unwrap_or_else(|| json!({}));
                let errors = validate_role_pack_input(pack, &inputs);
                let schema_valid = errors.is_empty();
                let mut output = json!({
                    "valid": schema_valid,
                    "errors": errors,
                    "selected": { "id": pack.id, "version": pack.version },
                    "gateStatus": pack.verification_gates.iter().map(|gate| json!({
                        "gate": gate,
                        "status": if gate == "input_schema_valid" {
                            if schema_valid { "passed" } else { "failed" }
                        } else { "pending" },
                    })).collect::<Vec<_>>(),
                    "readyForHumanFinalReview": false,
                    "humanFinalReviewRequired": true,
                });
                let provenance = Self::provenance(pack, ctx, Some(&inputs));
                if let (Some(output), Some(provenance)) =
                    (output.as_object_mut(), provenance.as_object())
                {
                    output.extend(provenance.clone());
                }
                Ok(output)
            }
            other => Err(format!("Unsupported role pack tool: {other}")),
        }
    }
}

#[async_trait]
impl ToolExecutor for RolePackExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::LIST | tool_names::GET | tool_names::VALIDATE
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let output = self.execute_read(&call.name, &call.arguments, ctx);
        let duration_ms = start.elapsed().as_millis() as u64;
        let result = match output {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(
                    json!({ "result": output, "durationMs": duration_ms }),
                ));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&result) {
            log::warn!("[RolePackExecutor] Failed to save tool block: {error}");
        }
        Ok(result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "RolePackExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_only_read_only_role_pack_tools() {
        let executor = RolePackExecutor::new();
        assert!(executor.can_handle("builtin-role_pack_list"));
        assert!(executor.can_handle("role_pack_get"));
        assert!(executor.can_handle("builtin-role_pack_validate"));
        assert!(!executor.can_handle("role_pack_apply"));
        assert_eq!(
            executor.sensitivity_level("role_pack_get"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.concurrency_class("role_pack_validate"),
            ToolConcurrency::ReadOnly
        );
    }

    #[test]
    fn exact_version_selection_does_not_silently_upgrade() {
        let selected = RolePackExecutor::selected_pack(&json!({
            "pack_id": "finance-core",
            "version": "1.0.0"
        }))
        .unwrap();
        assert_eq!(selected.version, "1.0.0");
    }
}
