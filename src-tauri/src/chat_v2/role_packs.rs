//! Versioned, data-driven role packs for repeatable professional workflows.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ROLE_PACK_REGISTRY_REVISION: &str = "2026-07-19.1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolePackWorkflow {
    pub id: String,
    pub title: String,
    pub steps: Vec<String>,
    pub human_final_review_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolePack {
    pub id: String,
    pub domain: String,
    pub title: String,
    pub version: String,
    pub deprecated: bool,
    pub input_schema: Value,
    pub rules: Vec<String>,
    pub rubric: Vec<String>,
    pub template_refs: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub exception_queue_schema: Value,
    pub verification_gates: Vec<String>,
    pub delivery_manifest: Value,
    pub workflows: Vec<RolePackWorkflow>,
    pub high_risk: bool,
    pub human_final_review_required: bool,
}

fn workflow(id: &str, title: &str, steps: &[&str]) -> RolePackWorkflow {
    RolePackWorkflow {
        id: id.into(),
        title: title.into(),
        steps: steps.iter().map(|step| (*step).to_string()).collect(),
        human_final_review_required: true,
    }
}

fn pack(
    id: &str,
    domain: &str,
    title: &str,
    version: &str,
    deprecated: bool,
    required_inputs: &[&str],
    capabilities: &[&str],
    workflows: Vec<RolePackWorkflow>,
    high_risk: bool,
) -> RolePack {
    let properties = required_inputs
        .iter()
        .map(|name| {
            (
                (*name).to_string(),
                json!({ "type": "string", "minLength": 1 }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    RolePack {
        id: id.into(),
        domain: domain.into(),
        title: title.into(),
        version: version.into(),
        deprecated,
        input_schema: json!({
            "type": "object",
            "additionalProperties": true,
            "required": required_inputs,
            "properties": properties,
        }),
        rules: vec![
            "Preserve source evidence and never invent missing fields".into(),
            "Route ambiguity, policy conflicts, and unsupported conclusions to the exception queue"
                .into(),
            "Do not execute irreversible delivery actions from a role pack".into(),
        ],
        rubric: vec![
            "Every conclusion is traceable to an input or rule".into(),
            "Exceptions include owner, severity, evidence, and recommended next action".into(),
            "Delivery manifest counts reconcile with processed and exception items".into(),
        ],
        template_refs: vec![
            format!("builtin://role-packs/{id}/{version}/report"),
            format!("builtin://role-packs/{id}/{version}/exceptions"),
        ],
        required_capabilities: capabilities.iter().map(|value| (*value).into()).collect(),
        exception_queue_schema: json!({
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["itemId", "severity", "reason", "evidenceRefs", "owner", "status"],
                "properties": {
                    "itemId": { "type": "string" },
                    "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
                    "reason": { "type": "string" },
                    "evidenceRefs": { "type": "array", "items": { "type": "string" } },
                    "owner": { "type": "string" },
                    "status": { "type": "string", "enum": ["open", "reviewed", "resolved", "waived"] }
                }
            }
        }),
        verification_gates: vec![
            "input_schema_valid".into(),
            "source_evidence_complete".into(),
            "exception_queue_reconciled".into(),
            "delivery_manifest_reconciled".into(),
            "human_final_review".into(),
        ],
        delivery_manifest: json!({
            "schemaVersion": 1,
            "required": [
                "rolePackId", "rolePackVersion", "inputDigest", "outputArtifacts",
                "processedCount", "exceptionCount", "verificationGates", "reviewDecision"
            ],
            "reviewDecision": { "enum": ["pending", "approved", "rejected", "approved_with_exceptions"] },
        }),
        workflows,
        high_risk,
        human_final_review_required: true,
    }
}

fn build_registry() -> Vec<RolePack> {
    vec![
        pack(
            "finance-core",
            "finance",
            "Finance Reconciliation",
            "1.0.0",
            true,
            &["invoiceBatch", "ledgerSnapshot"],
            &["xlsx", "workspace_read"],
            vec![workflow(
                "invoice-reconcile",
                "Invoice reconcile",
                &[
                    "ingest invoices and ledger",
                    "normalize vendor and amount fields",
                    "match and classify variances",
                    "queue unresolved exceptions",
                    "produce reconciliation workbook and manifest",
                    "human finance owner final review",
                ],
            )],
            true,
        ),
        pack(
            "finance-core",
            "finance",
            "Finance Reconciliation",
            "1.1.0",
            false,
            &["invoiceBatch", "ledgerSnapshot", "materialityPolicy"],
            &["xlsx", "workspace_read"],
            vec![workflow(
                "invoice-reconcile",
                "Invoice reconcile",
                &[
                    "ingest invoices and ledger",
                    "normalize vendor, tax, currency, and amount fields",
                    "match under materiality policy",
                    "queue unresolved exceptions",
                    "produce reconciliation workbook and manifest",
                    "human finance owner final review",
                ],
            )],
            true,
        ),
        pack(
            "legal-review",
            "legal",
            "Legal Review",
            "1.0.0",
            false,
            &["contractSet", "reviewPlaybook"],
            &["docx", "workspace_read"],
            vec![workflow(
                "contract-review",
                "Contract review",
                &[
                    "ingest contract and playbook",
                    "extract clauses with citations",
                    "compare deviations against playbook",
                    "queue ambiguous or high-risk clauses",
                    "produce redline issue list",
                    "licensed counsel final review",
                ],
            )],
            true,
        ),
        pack(
            "hr-operations",
            "hr",
            "HR Operations",
            "1.0.0",
            false,
            &["resumeBatch", "jobCriteria"],
            &["document_parse", "workspace_read"],
            vec![workflow(
                "resume-batch",
                "Resume batch",
                &[
                    "ingest resumes and job criteria",
                    "extract job-relevant evidence only",
                    "apply consistent rubric",
                    "queue missing or ambiguous evidence",
                    "produce review matrix without protected-trait inference",
                    "authorized HR reviewer final decision",
                ],
            )],
            true,
        ),
        pack(
            "operations-control",
            "operations",
            "Operations Control",
            "1.0.0",
            false,
            &["operatingData", "reportingPeriod"],
            &["xlsx", "docx", "workspace_read"],
            vec![workflow(
                "operations-report",
                "Operations report",
                &[
                    "ingest period data",
                    "validate completeness and reconcile totals",
                    "calculate approved metrics",
                    "queue anomalies and missing owners",
                    "produce operations report and manifest",
                    "operations owner final review",
                ],
            )],
            false,
        ),
        pack(
            "admin-communications",
            "admin",
            "Administrative Communications",
            "1.0.0",
            false,
            &["recipientTable", "approvedTemplate"],
            &["docx", "xlsx", "workspace_read"],
            vec![workflow(
                "mail-merge",
                "Mail merge",
                &[
                    "ingest approved template and recipients",
                    "validate required merge fields",
                    "render drafts only",
                    "queue missing or invalid recipient data",
                    "produce preview bundle and manifest",
                    "authorized sender final review and send",
                ],
            )],
            true,
        ),
        pack(
            "research-evidence",
            "research",
            "Research Evidence",
            "1.0.0",
            false,
            &["researchQuestion", "sourceSet"],
            &["academic_search", "workspace_read"],
            vec![],
            false,
        ),
        pack(
            "teaching-design",
            "teaching",
            "Teaching Design",
            "1.0.0",
            false,
            &["learningObjectives", "learnerProfile"],
            &["qbank", "docx"],
            vec![],
            false,
        ),
        pack(
            "content-production",
            "content",
            "Content Production",
            "1.0.0",
            false,
            &["contentBrief", "sourceSet"],
            &["docx", "workspace_read"],
            vec![],
            false,
        ),
    ]
}

pub fn role_pack_registry() -> &'static [RolePack] {
    static REGISTRY: OnceLock<Vec<RolePack>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry)
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

pub fn find_role_pack(pack_id: &str, version: Option<&str>) -> Option<&'static RolePack> {
    let matches = role_pack_registry()
        .iter()
        .filter(|pack| pack.id == pack_id);
    match version.map(str::trim).filter(|value| !value.is_empty()) {
        Some(version) => matches.into_iter().find(|pack| pack.version == version),
        None => matches.max_by_key(|pack| version_parts(&pack.version)),
    }
}

pub fn validate_role_pack_input(pack: &RolePack, input: &Value) -> Vec<String> {
    let Some(object) = input.as_object() else {
        return vec!["inputs must be an object".into()];
    };
    pack.input_schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|field| match object.get(*field) {
            None => true,
            Some(value) => {
                value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
            }
        })
        .map(|field| format!("missing required input: {field}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_required_domains_and_contract_fields() {
        for domain in [
            "finance",
            "legal",
            "hr",
            "operations",
            "admin",
            "research",
            "teaching",
            "content",
        ] {
            assert!(
                role_pack_registry()
                    .iter()
                    .any(|pack| pack.domain == domain),
                "missing {domain}"
            );
        }
        for pack in role_pack_registry() {
            assert!(!pack.version.is_empty());
            assert!(pack.input_schema.get("required").is_some());
            assert!(!pack.rules.is_empty() && !pack.rubric.is_empty());
            assert!(!pack.template_refs.is_empty() && !pack.required_capabilities.is_empty());
            assert!(pack.exception_queue_schema.get("items").is_some());
            assert!(pack
                .verification_gates
                .contains(&"human_final_review".to_string()));
            assert!(pack.delivery_manifest.get("required").is_some());
            if pack.high_risk {
                assert!(pack.human_final_review_required);
            }
        }
    }

    #[test]
    fn explicit_old_version_remains_selectable_and_latest_is_newest() {
        assert_eq!(
            find_role_pack("finance-core", Some("1.0.0"))
                .unwrap()
                .version,
            "1.0.0"
        );
        assert_eq!(
            find_role_pack("finance-core", None).unwrap().version,
            "1.1.0"
        );
    }

    #[test]
    fn registry_covers_required_composable_workflows_with_human_review() {
        for workflow_id in [
            "invoice-reconcile",
            "contract-review",
            "resume-batch",
            "mail-merge",
            "operations-report",
        ] {
            let workflow = role_pack_registry()
                .iter()
                .flat_map(|pack| &pack.workflows)
                .find(|workflow| workflow.id == workflow_id)
                .expect("workflow");
            assert!(workflow.steps.len() >= 5);
            assert!(workflow.human_final_review_required);
        }
    }

    #[test]
    fn schema_validation_reports_missing_inputs() {
        let pack = find_role_pack("legal-review", Some("1.0.0")).unwrap();
        let errors = validate_role_pack_input(pack, &json!({ "contractSet": "contracts/" }));
        assert_eq!(errors, vec!["missing required input: reviewPlaybook"]);
    }
}
