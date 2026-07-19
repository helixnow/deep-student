//! Shared delivery contract for generated OOXML files.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::ExecutionContext;
use crate::chat_v2::runtime_roots::{
    revalidate_runtime_root, runtime_root_by_id, temp_root, RuntimeRootAccess, RuntimeRootKind,
};
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, ProviderObjectRef, TaskObjectHandle,
    TaskObjectKind,
};
use crate::chat_v2::workspace_change_set::{self, ChangeSet, MutationKind};
use crate::commands::AppState;
use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeOperation {
    Create,
    ReplaceText,
}

impl OfficeOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::ReplaceText => "replace_text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OutputOptions {
    target: String,
    root_id: Option<String>,
    relative_path: Option<String>,
    overwrite_policy: String,
    expected_sha256: Option<String>,
}

fn parse_output_options(args: &Value, file_name: &str) -> Result<OutputOptions, String> {
    let target = args
        .get("output_target")
        .and_then(Value::as_str)
        .unwrap_or("vfs")
        .trim()
        .to_ascii_lowercase();
    if target != "vfs" && target != "workspace" {
        return Err("output_target must be 'vfs' or 'workspace'".to_string());
    }
    let root_id = args
        .get("root_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let relative_path = args
        .get("relative_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let overwrite_policy = args
        .get("overwrite_policy")
        .and_then(Value::as_str)
        .unwrap_or("fail")
        .trim()
        .to_ascii_lowercase();
    if overwrite_policy != "fail" && overwrite_policy != "replace_if_match" {
        return Err("overwrite_policy must be 'fail' or 'replace_if_match'".to_string());
    }
    let expected_sha256 = args
        .get("expected_sha256")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if target == "vfs" {
        if root_id.is_some()
            || relative_path.is_some()
            || expected_sha256.is_some()
            || overwrite_policy != "fail"
        {
            return Err(
                "root_id, relative_path, and expected_sha256 are only valid for workspace output"
                    .to_string(),
            );
        }
    } else {
        if args.get("folder_id").is_some() {
            return Err("folder_id is only valid for VFS output".to_string());
        }
        if root_id.as_deref().unwrap_or("workspace") != "workspace" {
            return Err(
                "Office workspace output currently requires root_id='workspace'".to_string(),
            );
        }
        if relative_path.is_none() && file_name.trim().is_empty() {
            return Err("relative_path is required for workspace output".to_string());
        }
        match overwrite_policy.as_str() {
            "fail" if expected_sha256.is_some() => {
                return Err(
                    "expected_sha256 requires overwrite_policy='replace_if_match'".to_string(),
                )
            }
            "replace_if_match" if expected_sha256.is_none() => {
                return Err("replace_if_match requires expected_sha256".to_string())
            }
            _ => {}
        }
    }

    Ok(OutputOptions {
        target,
        root_id,
        relative_path,
        overwrite_policy,
        expected_sha256,
    })
}

pub fn deliver_office_bytes(
    ctx: &ExecutionContext,
    args: &Value,
    bytes: &[u8],
    format: &str,
    mime_type: &str,
    file_name: &str,
    folder_id: Option<&str>,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
) -> Result<Value, String> {
    let options = parse_output_options(args, file_name)?;
    if options.target == "vfs" {
        deliver_vfs(
            ctx,
            bytes,
            format,
            mime_type,
            file_name,
            folder_id,
            operation,
            source_resource_id,
        )
    } else {
        deliver_workspace(
            ctx,
            bytes,
            format,
            mime_type,
            file_name,
            operation,
            source_resource_id,
            options,
        )
    }
}

fn deliver_vfs(
    ctx: &ExecutionContext,
    bytes: &[u8],
    format: &str,
    mime_type: &str,
    file_name: &str,
    folder_id: Option<&str>,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
) -> Result<Value, String> {
    let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
    let blob = VfsBlobRepo::store_blob(vfs_db, bytes, Some(mime_type), Some(format))
        .map_err(|error| format!("VFS Blob 存储失败: {}", error))?;
    let vfs_file = VfsFileRepo::create_file_in_folder(
        vfs_db,
        &blob.hash,
        file_name,
        bytes.len() as i64,
        "document",
        Some(mime_type),
        Some(&blob.hash),
        None,
        folder_id,
    )
    .map_err(|error| format!("VFS 文件创建失败: {}", error))?;
    let handle = vfs_task_object(
        &vfs_file.id,
        file_name,
        mime_type,
        bytes,
        format,
        operation,
        source_resource_id,
    )?;
    let id_key = if operation == OfficeOperation::Create {
        "file_id"
    } else {
        "new_file_id"
    };
    let mut output = json!({
        "success": true,
        "output_target": "vfs",
        "file_name": file_name,
        "file_size": bytes.len(),
        "format": format,
        "sha256": hex::encode(Sha256::digest(bytes)),
        "object_handle": handle,
        "fidelity_manifest": fidelity_manifest(format, operation),
    });
    output[id_key] = json!(vfs_file.id);
    if let Some(source) = source_resource_id {
        output["source_resource_id"] = json!(source);
    }
    Ok(output)
}

fn deliver_workspace(
    ctx: &ExecutionContext,
    bytes: &[u8],
    format: &str,
    mime_type: &str,
    file_name: &str,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
    options: OutputOptions,
) -> Result<Value, String> {
    let state = ctx.window_ref().state::<AppState>();
    let root = runtime_root_by_id(
        ctx.window_ref().app_handle(),
        &state.database,
        &ctx.session_id,
        ctx.skill_package_roots.as_ref(),
        options.root_id.as_deref().or(Some("workspace")),
        true,
    )?;
    if root.kind != RuntimeRootKind::Workspace
        || root.access != RuntimeRootAccess::ReadWrite
        || !root.configured
    {
        return Err("Office output requires a configured read-write workspace root".to_string());
    }
    let root_canon = revalidate_runtime_root(&state.database, &root)?;
    let relative_path = options
        .relative_path
        .unwrap_or_else(|| file_name.to_string());
    let required_suffix = format!(".{}", format);
    if !relative_path
        .to_ascii_lowercase()
        .ends_with(&required_suffix)
    {
        return Err(format!(
            "workspace Office output path must end with '{}'",
            required_suffix
        ));
    }
    let expected = if options.overwrite_policy == "replace_if_match" {
        options.expected_sha256.as_deref()
    } else {
        None
    };
    let temp = temp_root(ctx.window_ref().app_handle(), &ctx.session_id, true)?;
    let receipt = workspace_change_set::write_bytes(
        &root_canon,
        &temp.path,
        &root.id,
        &relative_path,
        bytes,
        expected,
    )?;
    let change_set = ChangeSet::single(receipt.clone());
    let change_set_changes = change_set.changes.clone();
    let created = usize::from(receipt.op == MutationKind::Created);
    let modified = usize::from(receipt.op == MutationKind::Modified);
    let result_relative_path = receipt.relative_path.clone();
    let result_sha256 = receipt.after_hash.clone();
    let handle = workspace_task_object(
        file_name,
        mime_type,
        bytes,
        &root.id,
        &receipt.relative_path,
        format,
        operation,
        source_resource_id,
    )?;
    let mut output = json!({
        "success": true,
        "output_target": "workspace",
        "root_id": root.id,
        "relative_path": result_relative_path,
        "file_name": file_name,
        "file_size": bytes.len(),
        "format": format,
        "sha256": result_sha256,
        "overwrite_policy": options.overwrite_policy,
        "mutation_receipt": receipt,
        "change_set": change_set,
        "file_change_summary": {
            "created": created,
            "modified": modified,
            "deleted": 0,
            "bytes_written": bytes.len(),
            "changes": change_set_changes,
        },
        "object_handle": handle,
        "fidelity_manifest": fidelity_manifest(format, operation),
    });
    if let Some(source) = source_resource_id {
        output["source_resource_id"] = json!(source);
    }
    Ok(output)
}

fn common_handle(
    handle_id: String,
    display_name: &str,
    mime_type: &str,
    bytes: &[u8],
    format: &str,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
) -> TaskObjectHandle {
    let mut handle = TaskObjectHandle::new(
        handle_id,
        TaskObjectKind::File,
        display_name,
        ObjectProvenance {
            source: "deep-student-office".to_string(),
            source_uri: source_resource_id.map(|id| format!("vfs://{}", id)),
            server: None,
            tool: Some(format!("{}_{}", format, operation.as_str())),
            derived_from: source_resource_id
                .map(|id| vec![format!("vfs:{}", id)])
                .unwrap_or_default(),
            observed_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    handle.media_type = Some(mime_type.to_string());
    handle.size_bytes = Some(bytes.len() as u64);
    handle.sha256 = Some(hex::encode(Sha256::digest(bytes)));
    handle
}

fn vfs_task_object(
    file_id: &str,
    display_name: &str,
    mime_type: &str,
    bytes: &[u8],
    format: &str,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
) -> Result<TaskObjectHandle, String> {
    let mut handle = common_handle(
        format!("vfs-file:{}", file_id),
        display_name,
        mime_type,
        bytes,
        format,
        operation,
        source_resource_id,
    );
    handle.provider_ref = Some(ProviderObjectRef {
        provider: "deep-student-vfs".to_string(),
        external_id: file_id.to_string(),
        container_id: None,
        thread_id: None,
        version: None,
        etag: handle.sha256.clone(),
    });
    handle.capabilities = ObjectCapabilities {
        readable: true,
        materializable: false,
        writable: true,
        shareable: false,
        sendable: false,
        deletable: true,
    };
    handle.validate()?;
    Ok(handle)
}

fn workspace_task_object(
    display_name: &str,
    mime_type: &str,
    bytes: &[u8],
    root_id: &str,
    relative_path: &str,
    format: &str,
    operation: OfficeOperation,
    source_resource_id: Option<&str>,
) -> Result<TaskObjectHandle, String> {
    let hash = hex::encode(Sha256::digest(bytes));
    let mut handle = common_handle(
        format!("workspace-file:{}:{}", root_id, hash),
        display_name,
        mime_type,
        bytes,
        format,
        operation,
        source_resource_id,
    );
    handle.locator = Some(ManagedLocator::new(root_id, relative_path)?);
    handle.capabilities = ObjectCapabilities {
        readable: true,
        materializable: true,
        writable: true,
        shareable: false,
        sendable: false,
        deletable: true,
    };
    handle.validate()?;
    Ok(handle)
}

fn fidelity_manifest(format: &str, operation: OfficeOperation) -> Value {
    let unsupported = match format {
        "docx" => vec![
            "macros",
            "tracked_changes",
            "embedded_ole",
            "full_style_round_trip",
        ],
        "xlsx" => vec![
            "macros",
            "charts",
            "pivot_tables",
            "external_links",
            "full_formula_round_trip",
        ],
        "pptx" => vec![
            "macros",
            "animations",
            "transitions",
            "speaker_notes",
            "slide_master_round_trip",
        ],
        _ => vec!["macros", "unknown_ooxml_extensions"],
    };
    json!({
        "contract": super::office_fidelity_executor::OFFICE_FIDELITY_CONTRACT,
        "format": format,
        "operation": operation.as_str(),
        "preserved": if operation == OfficeOperation::Create {
            vec!["supported_spec_content", "generated_ooxml_package"]
        } else {
            vec!["supported_text_content", "supported_structural_content"]
        },
        "unsupported_or_not_guaranteed": unsupported,
        "macros": {
            "execution_policy": "never_execute",
            "preservation": "not_supported",
            "default_source_action": "refuse",
            "explicit_strip_policy": "macro_policy=strip",
            "signature_invalidation_label_required": true,
        },
        "source_preflight": {
            "tool": "builtin-office_fidelity_inspect",
            "required_for_source_edits": true,
            "inspection_result_consumed_by_current_resource_id_editors": false,
            "preservation_claim_allowed": false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vfs_defaults_preserve_legacy_target() {
        let options = parse_output_options(&json!({}), "report.docx").unwrap();
        assert_eq!(options.target, "vfs");
    }

    #[test]
    fn workspace_replace_requires_hash_bound_policy() {
        assert!(parse_output_options(
            &json!({"output_target":"workspace","relative_path":"report.docx","overwrite_policy":"replace_if_match"}),
            "report.docx"
        ).is_err());
        assert!(parse_output_options(
            &json!({"output_target":"workspace","relative_path":"report.docx","expected_sha256":"a"}),
            "report.docx"
        ).is_err());
    }

    #[test]
    fn fidelity_manifest_is_explicit_about_macro_policy() {
        let manifest = fidelity_manifest("xlsx", OfficeOperation::ReplaceText);
        assert_eq!(
            manifest["contract"],
            crate::chat_v2::tools::office_fidelity_executor::OFFICE_FIDELITY_CONTRACT
        );
        assert_eq!(manifest["macros"]["execution_policy"], "never_execute");
        assert_eq!(manifest["macros"]["preservation"], "not_supported");
        assert_eq!(manifest["macros"]["default_source_action"], "refuse");
        assert_eq!(
            manifest["source_preflight"]["tool"],
            "builtin-office_fidelity_inspect"
        );
        assert_eq!(
            manifest["source_preflight"]
                ["inspection_result_consumed_by_current_resource_id_editors"],
            false
        );
    }
}
