use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    artifact_root, create_write_backup, normalize_runtime_relative_path, runtime_root_by_id,
    temp_root, RuntimeRoot, RuntimeRootKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub mod tool_names {
    pub const FILE_LIST: &str = "workspace_file_list";
    pub const FILE_READ: &str = "workspace_file_read";
    pub const ARTIFACT_WRITE: &str = "workspace_artifact_write";
}

pub struct WorkspaceFsExecutor;

impl WorkspaceFsExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn resolve_root(root_id: Option<&str>, ctx: &ExecutionContext) -> Result<RuntimeRoot, String> {
        let state = ctx.window.state::<AppState>();
        runtime_root_by_id(
            &ctx.window.app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            root_id,
            true,
        )
    }

    fn normalize_relative_path(raw: Option<&str>) -> Result<PathBuf, String> {
        normalize_runtime_relative_path(raw)
    }

    fn ensure_inside_existing(root: &RuntimeRoot, relative: &Path) -> Result<PathBuf, String> {
        let root_canon = root
            .path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize runtime root: {}", e))?;
        let target = root.path.join(relative);
        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("Path does not exist or cannot be read: {}", e))?;
        if !target_canon.starts_with(&root_canon) {
            return Err("Path escapes the selected runtime root".to_string());
        }
        Ok(target_canon)
    }

    fn ensure_write_target(root: &RuntimeRoot, relative: &Path) -> Result<PathBuf, String> {
        if root.kind != RuntimeRootKind::Artifact {
            return Err("Only the artifacts runtime root is writable".to_string());
        }
        if relative.as_os_str().is_empty() {
            return Err("Artifact path is required".to_string());
        }

        fs::create_dir_all(&root.path)
            .map_err(|e| format!("Failed to create artifact root: {}", e))?;
        let root_canon = root
            .path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize artifact root: {}", e))?;
        let target = root.path.join(relative);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                return Err("Writing through symlinks is not allowed".to_string());
            }
            if meta.is_dir() {
                return Err("Cannot write text content to a directory".to_string());
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
            let parent_canon = parent
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize parent directory: {}", e))?;
            if !parent_canon.starts_with(&root_canon) {
                return Err("Artifact path escapes the runtime root".to_string());
            }
        }
        Ok(target)
    }

    fn root_json(root: &RuntimeRoot) -> Value {
        serde_json::to_value(root).unwrap_or_else(|_| {
            json!({
                "id": root.id,
                "label": root.label,
                "path": root.path.to_string_lossy(),
            })
        })
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }

    async fn execute_file_list(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let root = Self::resolve_root(args.get("root_id").and_then(|v| v.as_str()), ctx)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        let max_entries = args
            .get("max_entries")
            .and_then(|v| v.as_u64())
            .unwrap_or(200)
            .clamp(1, 500) as usize;
        let target = Self::ensure_inside_existing(&root, &relative)?;
        let metadata = fs::metadata(&target).map_err(|e| format!("Failed to read path: {}", e))?;
        if !metadata.is_dir() {
            return Err("workspace_file_list path must be a directory".to_string());
        }

        let mut entries = Vec::new();
        let mut skipped = 0usize;
        for entry in
            fs::read_dir(&target).map_err(|e| format!("Failed to list directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Failed to read entry type: {}", e))?;
            if file_type.is_symlink() {
                skipped += 1;
                continue;
            }
            if entries.len() >= max_entries {
                skipped += 1;
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let entry_relative = relative.join(&name);
            let meta = entry
                .metadata()
                .map_err(|e| format!("Failed to read entry metadata: {}", e))?;
            entries.push(json!({
                "name": name,
                "relative_path": entry_relative.to_string_lossy(),
                "kind": if meta.is_dir() { "directory" } else { "file" },
                "bytes": if meta.is_file() { Some(meta.len()) } else { None },
            }));
        }

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "entries": entries,
            "skipped": skipped,
        }))
    }

    async fn execute_file_read(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let root = Self::resolve_root(args.get("root_id").and_then(|v| v.as_str()), ctx)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        if relative.as_os_str().is_empty() {
            return Err("path is required".to_string());
        }
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(64 * 1024)
            .clamp(1, 1024 * 1024) as usize;
        let target = Self::ensure_inside_existing(&root, &relative)?;
        let meta =
            fs::metadata(&target).map_err(|e| format!("Failed to read file metadata: {}", e))?;
        if !meta.is_file() {
            return Err("workspace_file_read path must be a file".to_string());
        }
        let bytes = fs::read(&target).map_err(|e| format!("Failed to read file: {}", e))?;
        let truncated = bytes.len() > max_bytes;
        let visible = if truncated {
            &bytes[..max_bytes]
        } else {
            &bytes[..]
        };
        let content = String::from_utf8(visible.to_vec()).map_err(|_| {
            "workspace_file_read currently supports UTF-8 text files only".to_string()
        })?;

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "content": content,
            "bytes": bytes.len(),
            "sha256": Self::sha256_hex(&bytes),
            "truncated": truncated,
        }))
    }

    async fn execute_artifact_write(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let root = artifact_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required")?;
        let overwrite = args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let target = Self::ensure_write_target(&root, &relative)?;
        let before = if target.exists() {
            if !overwrite {
                return Err("Artifact already exists and overwrite=false".to_string());
            }
            Some(
                fs::read(&target)
                    .map_err(|e| format!("Failed to read existing artifact: {}", e))?,
            )
        } else {
            None
        };
        let file_name = relative
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| relative.to_string_lossy().to_string());
        // 覆盖已存在文件前先把旧内容备份到 temp 根备份区；备份失败则整个写入中止，
        // 保证只要返回了 modified change，就一定有可用的 backup_ref 供撤销恢复。
        let backup_ref = match before.as_ref() {
            Some(old_bytes) => {
                let temp = temp_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
                Some(create_write_backup(&temp.path, &file_name, old_bytes)?)
            }
            None => None,
        };

        fs::write(&target, content.as_bytes())
            .map_err(|e| format!("Failed to write artifact: {}", e))?;
        let after = fs::read(&target).map_err(|e| format!("Failed to verify artifact: {}", e))?;
        let op = if before.is_some() {
            "modified"
        } else {
            "created"
        };

        let mut change = json!({
            "op": op,
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "before_hash": before.as_ref().map(|bytes| Self::sha256_hex(bytes)),
            "after_hash": Self::sha256_hex(&after),
            "bytes": after.len(),
        });
        // backup_ref 仅在覆盖写时出现，None 时不落 key，保持旧前端向后兼容
        if let Some(ref backup_ref) = backup_ref {
            change["backup_ref"] = json!(backup_ref);
        }

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "path": relative.to_string_lossy(),
            "file_name": file_name,
            "bytes_written": after.len(),
            "sha256": Self::sha256_hex(&after),
            "file_change_summary": {
                "created": if before.is_none() { 1 } else { 0 },
                "modified": if before.is_some() { 1 } else { 0 },
                "deleted": 0,
                "bytes_written": after.len(),
                "changes": [change]
            }
        }))
    }
}

#[async_trait]
impl ToolExecutor for WorkspaceFsExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::FILE_LIST | tool_names::FILE_READ | tool_names::ARTIFACT_WRITE
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            tool_names::FILE_LIST => self.execute_file_list(&call.arguments, ctx).await,
            tool_names::FILE_READ => self.execute_file_read(&call.arguments, ctx).await,
            tool_names::ARTIFACT_WRITE => self.execute_artifact_write(&call.arguments, ctx).await,
            _ => Err(format!("Unknown workspace filesystem tool: {}", tool_name)),
        };

        let duration_ms = start.elapsed().as_millis() as u64;
        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration_ms,
                })));
                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[WorkspaceFsExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration_ms,
                );
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[WorkspaceFsExecutor] Failed to save tool block: {}", e);
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::strip_namespace(tool_name) {
            tool_names::ARTIFACT_WRITE => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "WorkspaceFsExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_safe_relative_path() {
        assert_eq!(
            WorkspaceFsExecutor::normalize_relative_path(Some("./notes/summary.md")).unwrap(),
            PathBuf::from("notes").join("summary.md")
        );
        assert_eq!(
            WorkspaceFsExecutor::normalize_relative_path(Some("")).unwrap(),
            PathBuf::new()
        );
    }

    #[test]
    fn rejects_escape_paths() {
        assert!(WorkspaceFsExecutor::normalize_relative_path(Some("../secret.txt")).is_err());
        assert!(WorkspaceFsExecutor::normalize_relative_path(Some("a/../../secret.txt")).is_err());
        assert!(WorkspaceFsExecutor::normalize_relative_path(Some("/tmp/secret.txt")).is_err());
    }

    #[test]
    fn sanitizes_session_dir() {
        assert_eq!(
            crate::chat_v2::runtime_roots::safe_session_dir("sess:abc/123"),
            "sess_abc_123"
        );
    }

    #[test]
    fn overwrite_backups_land_in_temp_backup_area() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let backup_ref = crate::chat_v2::runtime_roots::create_write_backup(
            temp_dir.path(),
            "notes.md",
            b"old content",
        )
        .expect("backup");
        assert!(backup_ref.starts_with(".write_backups/"));
        assert!(backup_ref.ends_with("notes.md"));
        assert_eq!(
            fs::read(temp_dir.path().join(&backup_ref)).unwrap(),
            b"old content"
        );
    }

    #[test]
    fn sensitivity_marks_artifact_write_medium() {
        let executor = WorkspaceFsExecutor::new();
        assert!(executor.can_handle("workspace_file_read"));
        assert!(executor.can_handle("builtin-workspace_file_read"));
        assert_eq!(
            executor.sensitivity_level("builtin-workspace_artifact_write"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-workspace_file_read"),
            ToolSensitivity::Low
        );
    }
}
