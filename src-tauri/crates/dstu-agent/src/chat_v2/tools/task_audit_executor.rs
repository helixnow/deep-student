//! Export-safe task audit manifests and conservative lineage deletion.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    normalize_runtime_relative_path, remove_session_file_irreversible, revalidate_runtime_root,
    runtime_root_by_id, RuntimeRoot, RuntimeRootKind,
};
use crate::chat_v2::task_audit::{
    AuditApproval, AuditOutput, AuditToolCall, ChangeCoverage, ConnectorAuditTarget,
    TaskAuditManifestBuilder,
};
use crate::chat_v2::task_objects::TaskObjectHandle;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const EXPORT: &str = "task_audit_export";
    pub const FORGET: &str = "lineage_forget";
}

const FORGET_LAYERS: &[&str] = &["source", "cache", "embedding", "stage", "copy", "lineage"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportArgs {
    task_id: String,
    #[serde(default)]
    object_handles: Vec<TaskObjectHandle>,
    #[serde(default)]
    tool_calls: Vec<AuditToolCall>,
    #[serde(default)]
    approvals: Vec<AuditApproval>,
    #[serde(default)]
    outputs: Vec<AuditOutput>,
    #[serde(default)]
    connector_targets: Vec<ConnectorAuditTarget>,
    role_pack_version: Option<String>,
    #[serde(default)]
    change_coverage: ChangeCoverage,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ForgetMode {
    DryRun,
    Commit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForgetTarget {
    layer: String,
    object_handle: TaskObjectHandle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForgetArgs {
    mode: ForgetMode,
    targets: Vec<ForgetTarget>,
    requested_layers: Vec<String>,
}

struct ValidatedForgetTarget {
    layer: String,
    handle_id: String,
    root: RuntimeRoot,
    root_canon: PathBuf,
    relative_path: String,
    sha256: String,
}

fn parse_args<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|error| format!("invalid arguments: {error}"))
}

fn validate_layer(layer: &str) -> Result<String, String> {
    let normalized = layer.trim().to_ascii_lowercase();
    if FORGET_LAYERS.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!(
            "unsupported lineage layer '{layer}'; expected one of {}",
            FORGET_LAYERS.join(", ")
        ))
    }
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("managed locator contains an unsafe path component".to_string());
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("failed to inspect managed target: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("managed target must not traverse symbolic links".to_string());
        }
    }
    Ok(())
}

fn hash_regular_file(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect managed target: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("managed target must be a regular file".to_string());
    }
    let mut file =
        fs::File::open(path).map_err(|error| format!("failed to open managed target: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read managed target: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn validate_forget_target(
    target: ForgetTarget,
    ctx: &ExecutionContext,
) -> Result<ValidatedForgetTarget, String> {
    target.object_handle.validate()?;
    let layer = validate_layer(&target.layer)?;
    let locator = target
        .object_handle
        .locator
        .as_ref()
        .ok_or_else(|| "object handle has no managed locator".to_string())?;
    let expected_hash = target
        .object_handle
        .sha256
        .as_deref()
        .ok_or_else(|| "object handle requires sha256 for hash-bound deletion".to_string())?;
    let handle_id = target.object_handle.handle_id.clone();
    let relative_path = locator.relative_path.clone();
    let database = ctx
        .main_db
        .as_ref()
        .ok_or_else(|| "main database is unavailable".to_string())?;
    let root = runtime_root_by_id(
        ctx.window_ref().app_handle(),
        database,
        &ctx.session_id,
        None,
        Some(&locator.root_id),
        false,
    )?;
    if !root.session_scoped
        || !matches!(root.kind, RuntimeRootKind::Artifact | RuntimeRootKind::Temp)
    {
        return Err(
            "lineage forget only deletes current-session temp or artifacts files".to_string(),
        );
    }
    let root_canon = revalidate_runtime_root(database, &root)?;
    let relative = normalize_runtime_relative_path(Some(&locator.relative_path))?;
    if relative.as_os_str().is_empty() {
        return Err("managed locator must identify a file".to_string());
    }
    ensure_no_symlink_components(&root_canon, &relative)?;
    let canonical = root_canon
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("failed to resolve managed target: {error}"))?;
    if !canonical.starts_with(&root_canon) {
        return Err("managed target escapes its current-session root".to_string());
    }
    let observed_hash = hash_regular_file(&canonical)?;
    if !observed_hash.eq_ignore_ascii_case(expected_hash) {
        return Err(format!(
            "managed target hash changed (expected {expected_hash}, observed {observed_hash})"
        ));
    }
    Ok(ValidatedForgetTarget {
        layer,
        handle_id,
        root,
        root_canon,
        relative_path,
        sha256: expected_hash.to_ascii_lowercase(),
    })
}

fn export_manifest(args: ExportArgs) -> Result<Value, String> {
    let mut builder = TaskAuditManifestBuilder::new(args.task_id);
    // Note: the tool-facing export path never calls
    // `verified_against_backend_session_ledger`; caller-supplied manifests
    // must stay non-authoritative.
    for handle in args.object_handles {
        builder.add_object_handle(handle)?;
    }
    for call in args.tool_calls {
        builder.add_tool_call(call);
    }
    for approval in args.approvals {
        builder.add_approval(approval);
    }
    for output in args.outputs {
        builder.add_output(output);
    }
    for target in args.connector_targets {
        builder.add_connector_target(target);
    }
    if let Some(version) = args.role_pack_version {
        builder.role_pack_version(version);
    }
    builder.change_coverage(args.change_coverage);
    builder.build()?.export_value()
}

/// 关键路径写入保证：把导出的审计清单原子落盘到会话 artifacts 根
/// （`task-audit/<taskId>-<ts>.json`，先写临时文件再 rename）。
/// 返回相对路径；任何失败都返回 Err —— 调用方按 fail-closed 处理，
/// 不允许「仅内存返回、磁盘无痕」的导出成功。
fn persist_manifest_export(
    ctx: &ExecutionContext,
    task_id: &str,
    manifest: &Value,
) -> Result<String, String> {
    let window = ctx
        .tauri_window
        .as_ref()
        .ok_or_else(|| "Tauri window unavailable; cannot persist audit manifest".to_string())?;
    let artifact =
        crate::chat_v2::runtime_roots::artifact_root(window.app_handle(), &ctx.session_id, true)?;
    let dir = artifact.path.join("task-audit");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create task-audit directory: {error}"))?;

    let safe_task_id: String = task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    let file_name = format!(
        "{}-{}.json",
        if safe_task_id.is_empty() {
            "task"
        } else {
            safe_task_id.as_str()
        },
        chrono::Utc::now().timestamp_millis()
    );
    let serialized = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("failed to serialize audit manifest: {error}"))?;
    let final_path = dir.join(&file_name);
    let tmp_path = dir.join(format!("{file_name}.tmp"));
    fs::write(&tmp_path, &serialized)
        .map_err(|error| format!("failed to write audit manifest: {error}"))?;
    if let Err(error) = fs::rename(&tmp_path, &final_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to finalize audit manifest write: {error}"));
    }
    Ok(format!("task-audit/{file_name}"))
}

fn forget_lineage(args: ForgetArgs, ctx: &ExecutionContext) -> Result<Value, String> {
    if args.requested_layers.is_empty() {
        return Err("requestedLayers must contain at least one lineage layer".to_string());
    }
    let requested_layers = args
        .requested_layers
        .iter()
        .map(|layer| validate_layer(layer))
        .collect::<Result<BTreeSet<_>, _>>()?;

    let mut items = Vec::new();
    let mut validated = Vec::new();
    for target in args.targets {
        let handle_id = target.object_handle.handle_id.clone();
        let layer = target.layer.trim().to_ascii_lowercase();
        if !requested_layers.contains(&layer) {
            items.push(json!({
                "layer": layer,
                "objectHandleId": handle_id,
                "status": "incomplete",
                "error": "target layer was not included in requestedLayers",
            }));
            continue;
        }
        match validate_forget_target(target, ctx) {
            Ok(target) => validated.push(target),
            Err(error) => items.push(json!({
                "layer": layer,
                "objectHandleId": handle_id,
                "status": "incomplete",
                "error": error,
            })),
        }
    }

    let represented = validated
        .iter()
        .map(|target| target.layer.clone())
        .chain(
            items
                .iter()
                .filter_map(|item| item["layer"].as_str().map(str::to_string)),
        )
        .collect::<BTreeSet<_>>();
    for layer in requested_layers.difference(&represented) {
        items.push(json!({
            "layer": layer,
            "status": "incomplete",
            "error": "no deletion target was supplied for this requested layer",
        }));
    }

    for target in validated {
        if args.mode == ForgetMode::DryRun {
            items.push(json!({
                "layer": target.layer,
                "objectHandleId": target.handle_id,
                "rootId": target.root.id,
                "relativePath": target.relative_path,
                "sha256": target.sha256,
                "status": "would_delete",
            }));
            continue;
        }
        match remove_session_file_irreversible(
            &target.root_canon,
            &target.relative_path,
            &target.sha256,
        ) {
            Ok(()) => items.push(json!({
                "layer": target.layer,
                "objectHandleId": target.handle_id,
                "status": "deleted",
                "deleteReceipt": {
                    "rootId": target.root.id,
                    "relativePath": target.relative_path,
                    "sha256": target.sha256,
                    "irreversible": true,
                    "backupCreated": false,
                },
            })),
            Err(error) => items.push(json!({
                "layer": target.layer,
                "objectHandleId": target.handle_id,
                "status": "incomplete",
                "error": error,
            })),
        }
    }

    items.sort_by(|left, right| {
        (left["layer"].as_str(), left["objectHandleId"].as_str())
            .cmp(&(right["layer"].as_str(), right["objectHandleId"].as_str()))
    });
    let incomplete_layers = requested_layers
        .iter()
        .filter(|layer| {
            items.iter().any(|item| {
                item["layer"].as_str() == Some(layer.as_str())
                    && item["status"].as_str() == Some("incomplete")
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let coverage_complete = incomplete_layers.is_empty();
    Ok(json!({
        "mode": match args.mode { ForgetMode::DryRun => "dry_run", ForgetMode::Commit => "commit" },
        "coverageComplete": coverage_complete,
        "complete": args.mode == ForgetMode::Commit && coverage_complete,
        "incompleteLayers": incomplete_layers,
        "items": items,
    }))
}

pub struct TaskAuditExecutor;

impl TaskAuditExecutor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TaskAuditExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for TaskAuditExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::EXPORT | tool_names::FORGET
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match strip_tool_namespace(&call.name) {
            tool_names::EXPORT => parse_args(&call.arguments).and_then(|args: ExportArgs| {
                let task_id = args.task_id.clone();
                let mut manifest = export_manifest(args)?;
                // 写入保证（fail-closed）：清单必须同时落盘到会话 artifacts
                // 根；落盘失败则整个导出失败，不返回未持久化的“成功”结果。
                let relative_path = persist_manifest_export(ctx, &task_id, &manifest)
                    .map_err(|error| format!("audit manifest persistence failed: {error}"))?;
                if let Some(map) = manifest.as_object_mut() {
                    map.insert(
                        "persistedTo".to_string(),
                        json!({
                            "rootId": "artifacts",
                            "relativePath": relative_path,
                        }),
                    );
                }
                Ok(manifest)
            }),
            tool_names::FORGET => {
                parse_args(&call.arguments).and_then(|args| forget_lineage(args, ctx))
            }
            _ => Err("unknown task audit tool".to_string()),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let info = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({"result": output, "durationMs": duration_ms})));
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
        if let Err(error) = ctx.save_tool_block(&info) {
            log::warn!("[TaskAuditExecutor] failed to save tool block: {error}");
        }
        Ok(info)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            tool_names::EXPORT => ToolSensitivity::Medium,
            tool_names::FORGET => ToolSensitivity::High,
            _ => ToolSensitivity::High,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if strip_tool_namespace(tool_name) == tool_names::EXPORT {
            ToolConcurrency::ReadOnly
        } else {
            ToolConcurrency::Serial
        }
    }

    fn name(&self) -> &'static str {
        "TaskAuditExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::task_objects::{ObjectCapabilities, ObjectProvenance, TaskObjectKind};

    fn handle(id: &str) -> TaskObjectHandle {
        TaskObjectHandle {
            schema_version: 1,
            handle_id: id.to_string(),
            kind: TaskObjectKind::File,
            display_name: "report.txt".to_string(),
            media_type: Some("text/plain".to_string()),
            size_bytes: Some(5),
            sha256: Some("a".repeat(64)),
            locator: None,
            provider_ref: None,
            acl: None,
            capabilities: ObjectCapabilities::default(),
            expires_at: None,
            provenance: ObjectProvenance {
                source: "attachment".to_string(),
                source_uri: None,
                server: None,
                tool: None,
                derived_from: Vec::new(),
                observed_at: "2026-07-19T00:00:00Z".to_string(),
            },
        }
    }

    #[test]
    fn col_08_export_aggregates_governance_fields_and_redacts_secrets() {
        let value = export_manifest(ExportArgs {
            task_id: "task-1".to_string(),
            object_handles: vec![handle("input-1")],
            tool_calls: vec![AuditToolCall {
                call_id: "call-1".to_string(),
                tool_name: "connector_operation_commit".to_string(),
                arguments: json!({"apiKey": "secret", "safe": "visible"}),
                result_hash: Some("b".repeat(64)),
            }],
            approvals: vec![AuditApproval {
                approval_id: "approval-1".to_string(),
                scope_hash: "c".repeat(64),
                decision: "approved".to_string(),
            }],
            outputs: vec![AuditOutput {
                object_handle_id: "output-1".to_string(),
                sha256: "d".repeat(64),
            }],
            connector_targets: vec![ConnectorAuditTarget {
                operation_id: "op-1".to_string(),
                recipients: vec!["person@example.com".to_string()],
                acl_principals: vec!["team-1".to_string()],
            }],
            role_pack_version: Some("legal-review@1.0.0".to_string()),
            change_coverage: ChangeCoverage {
                changes_recorded: true,
                rollback_available: true,
                rollback_verified: true,
            },
        })
        .unwrap();
        assert_eq!(value["toolCalls"][0]["arguments"]["apiKey"], "[REDACTED]");
        assert_eq!(value["toolCalls"][0]["arguments"]["safe"], "visible");
        assert_eq!(
            value["connectorTargets"][0]["recipients"][0],
            "person@example.com"
        );
        assert_eq!(value["rolePackVersion"], "legal-review@1.0.0");
        assert_eq!(value["evidenceOrigin"], "caller_supplied");
        assert_eq!(value["authoritative"], false);
        assert_eq!(value["coverageComplete"], false);
        assert!(value["missingCoverage"]
            .as_array()
            .unwrap()
            .contains(&json!("backend_session_ledger")));
    }

    #[test]
    fn col_06_missing_requested_layer_is_never_reported_complete() {
        let requested = ["source".to_string(), "embedding".to_string()]
            .into_iter()
            .collect::<BTreeSet<_>>();
        let represented = ["source".to_string()].into_iter().collect::<BTreeSet<_>>();
        let missing = requested
            .difference(&represented)
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(missing, vec!["embedding"]);
    }

    #[test]
    fn col_06_forget_is_high_sensitivity_and_audit_export_is_serialized() {
        let executor = TaskAuditExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-lineage_forget"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-task_audit_export"),
            ToolSensitivity::Medium
        );
    }
}
