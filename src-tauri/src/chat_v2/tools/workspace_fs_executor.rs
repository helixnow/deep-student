use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    artifact_mutation_guard, create_write_backup_from_file, normalize_runtime_relative_path,
    revalidate_runtime_root, runtime_root_by_id, temp_root, RuntimeRoot, RuntimeRootAccess,
    RuntimeRootKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::chat_v2::workspace_change_set::{self, ChangeSet, MutationKind, MutationReceipt};
use crate::commands::AppState;

pub mod tool_names {
    pub const FILE_LIST: &str = "workspace_file_list";
    pub const FILE_READ: &str = "workspace_file_read";
    pub const ARTIFACT_WRITE: &str = "workspace_artifact_write";
    pub const FILE_WRITE: &str = "workspace_file_write";
    pub const FILE_MOVE: &str = "workspace_file_move";
    pub const FILE_DELETE: &str = "workspace_file_delete";
    pub const CHANGE_REVERT: &str = "workspace_change_revert";
}

const MAX_FILE_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARTIFACT_WRITE_BYTES: usize = 16 * 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_DIRECTORY_SCAN_ENTRIES: usize = 2_000;

struct BoundedFileRead {
    visible: Vec<u8>,
    bytes: u64,
    sha256: String,
    truncated: bool,
}

struct BoundedDirectoryList {
    entries: Vec<Value>,
    skipped: usize,
    scanned: usize,
    truncated: bool,
}

pub struct WorkspaceFsExecutor;

impl WorkspaceFsExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn resolve_root(
        root_id: Option<&str>,
        ctx: &ExecutionContext,
    ) -> Result<(RuntimeRoot, PathBuf), String> {
        let state = ctx.window.state::<AppState>();
        let root = runtime_root_by_id(
            &ctx.window.app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            root_id,
            true,
        )?;
        let canonical = revalidate_runtime_root(&state.database, &root)?;
        Ok((root, canonical))
    }

    fn normalize_relative_path(raw: Option<&str>) -> Result<PathBuf, String> {
        normalize_runtime_relative_path(raw)
    }

    fn ensure_no_symlink_components(root_canon: &Path, relative: &Path) -> Result<(), String> {
        let mut current = root_canon.to_path_buf();
        for component in relative.components() {
            let std::path::Component::Normal(part) = component else {
                continue;
            };
            current.push(part);
            let metadata = fs::symlink_metadata(&current).map_err(|error| {
                format!("Path does not exist or cannot be inspected: {}", error)
            })?;
            if metadata.file_type().is_symlink() {
                return Err("Workspace tools do not follow symlinks".to_string());
            }
        }
        Ok(())
    }

    fn ensure_inside_existing(root_canon: &Path, relative: &Path) -> Result<PathBuf, String> {
        Self::ensure_no_symlink_components(root_canon, relative)?;
        let target = root_canon.join(relative);
        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("Path does not exist or cannot be read: {}", e))?;
        if !target_canon.starts_with(&root_canon) {
            return Err("Path escapes the selected runtime root".to_string());
        }
        let canonical_relative = target_canon
            .strip_prefix(root_canon)
            .map_err(|_| "Path escapes the selected runtime root".to_string())?;
        Self::ensure_public_runtime_path(canonical_relative)?;
        Ok(target_canon)
    }

    fn ensure_write_target(
        root: &RuntimeRoot,
        root_canon: &Path,
        relative: &Path,
    ) -> Result<PathBuf, String> {
        if root.kind != RuntimeRootKind::Artifact {
            return Err("Only the artifacts runtime root is writable".to_string());
        }
        if relative.as_os_str().is_empty() {
            return Err("Artifact path is required".to_string());
        }

        let target = root_canon.join(relative);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                return Err("Writing through symlinks is not allowed".to_string());
            }
            if meta.is_dir() {
                return Err("Cannot write text content to a directory".to_string());
            }
        }
        let mut parent = root_canon.to_path_buf();
        if let Some(relative_parent) = relative.parent() {
            for component in relative_parent.components() {
                let std::path::Component::Normal(part) = component else {
                    continue;
                };
                parent.push(part);
                match fs::create_dir(&parent) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!("Failed to create artifact parent: {}", error))
                    }
                }
                let metadata = fs::symlink_metadata(&parent)
                    .map_err(|error| format!("Failed to inspect artifact parent: {}", error))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Artifact parent must be a real directory".to_string());
                }
            }
        }
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize parent directory: {}", e))?;
        if !parent_canon.starts_with(root_canon) {
            return Err("Artifact path escapes the runtime root".to_string());
        }
        let file_name = relative
            .file_name()
            .ok_or_else(|| "Artifact target has no file name".to_string())?;
        Ok(parent_canon.join(file_name))
    }

    fn ensure_writable_workspace(root: &RuntimeRoot) -> Result<(), String> {
        if root.kind != RuntimeRootKind::Workspace || root.id != "workspace" {
            return Err("Workspace mutation tools require root_id=workspace".to_string());
        }
        if root.access != RuntimeRootAccess::ReadWrite {
            return Err(
                "Workspace is read-only; the user must explicitly grant write access".to_string(),
            );
        }
        if !root.configured {
            return Err("Workspace write access requires a configured workspace root".to_string());
        }
        Ok(())
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

    fn is_private_component(component: &std::ffi::OsStr) -> bool {
        let Some(name) = component.to_str() else {
            return true;
        };
        let lower = name.trim().to_ascii_lowercase();
        if lower.is_empty() || lower.starts_with('.') {
            return true;
        }

        const SECRET_NAMES: &[&str] = &[
            "credential",
            "credentials",
            "credential.json",
            "credentials.json",
            "secret",
            "secrets",
            "secret.json",
            "secrets.json",
            "token",
            "tokens",
            "token.json",
            "tokens.json",
            "password",
            "passwords",
            "passwd",
            "shadow",
            "id_rsa",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
        ];
        SECRET_NAMES.contains(&lower.as_str())
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || lower.ends_with(".p12")
            || lower.ends_with(".pfx")
            || lower.contains("private_key")
            || lower.contains("private-key")
            || lower.starts_with("service-account")
            || lower.starts_with("service_account")
    }

    fn ensure_public_runtime_path(relative: &Path) -> Result<(), String> {
        if relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => Some(value),
                _ => None,
            })
            .any(Self::is_private_component)
        {
            return Err(
                "Hidden files and common credential/secret paths are not available to workspace tools"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn read_file_bounded(target: &Path, max_bytes: usize) -> Result<BoundedFileRead, String> {
        let before = fs::symlink_metadata(target)
            .map_err(|error| format!("Failed to inspect file: {}", error))?;
        if before.file_type().is_symlink() || !before.is_file() {
            return Err("workspace_file_read path must be a regular file".to_string());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        }
        let mut file = options.open(target).map_err(|error| {
            format!("Failed to open file without following symlinks: {}", error)
        })?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Failed to read file metadata: {}", error))?;
        if !metadata.is_file() {
            return Err("workspace_file_read path must be a file".to_string());
        }
        if !Self::metadata_matches(&before, &metadata) {
            return Err("workspace_file_read target changed while it was being opened".to_string());
        }
        if metadata.len() > MAX_FILE_SOURCE_BYTES {
            return Err(format!(
                "workspace_file_read refuses files larger than {} MiB",
                MAX_FILE_SOURCE_BYTES / (1024 * 1024)
            ));
        }

        let mut visible = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; READ_BUFFER_BYTES];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("Failed to read file: {}", error))?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or_else(|| "File length overflow while reading".to_string())?;
            if total > MAX_FILE_SOURCE_BYTES {
                return Err(format!(
                    "workspace_file_read stopped because the file grew beyond {} MiB",
                    MAX_FILE_SOURCE_BYTES / (1024 * 1024)
                ));
            }
            hasher.update(&buffer[..read]);
            let remaining = max_bytes.saturating_sub(visible.len());
            if remaining > 0 {
                visible.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }

        Ok(BoundedFileRead {
            truncated: total > visible.len() as u64,
            visible,
            bytes: total,
            sha256: hex::encode(hasher.finalize()),
        })
    }

    fn metadata_matches(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            return before.dev() == opened.dev() && before.ino() == opened.ino();
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            return before.volume_serial_number() == opened.volume_serial_number()
                && before.file_index() == opened.file_index();
        }
        #[cfg(not(any(unix, windows)))]
        {
            before.len() == opened.len()
                && before.modified().ok().is_some()
                && before.modified().ok() == opened.modified().ok()
        }
    }

    fn decode_utf8_prefix(bytes: &[u8], truncated: bool) -> Result<String, String> {
        match std::str::from_utf8(bytes) {
            Ok(text) => Ok(text.to_string()),
            Err(error) if truncated && error.error_len().is_none() => {
                Ok(String::from_utf8_lossy(&bytes[..error.valid_up_to()]).to_string())
            }
            Err(_) => {
                Err("workspace_file_read currently supports UTF-8 text files only".to_string())
            }
        }
    }

    fn list_directory_bounded(
        target: &Path,
        relative: &Path,
        max_entries: usize,
    ) -> Result<BoundedDirectoryList, String> {
        let mut iterator =
            fs::read_dir(target).map_err(|error| format!("Failed to list directory: {}", error))?;
        let scan_limit = max_entries
            .saturating_mul(4)
            .max(max_entries)
            .min(MAX_DIRECTORY_SCAN_ENTRIES);
        let mut entries = Vec::with_capacity(max_entries);
        let mut skipped = 0usize;
        let mut scanned = 0usize;

        while scanned < scan_limit && entries.len() < max_entries {
            let Some(entry) = iterator.next() else {
                return Ok(BoundedDirectoryList {
                    entries,
                    skipped,
                    scanned,
                    truncated: false,
                });
            };
            let entry =
                entry.map_err(|error| format!("Failed to read directory entry: {}", error))?;
            scanned += 1;
            let name = entry.file_name();
            if Self::is_private_component(&name) {
                skipped += 1;
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Failed to read entry type: {}", error))?;
            if file_type.is_symlink() {
                skipped += 1;
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|error| format!("Failed to read entry metadata: {}", error))?;
            let name_display = name.to_string_lossy().to_string();
            let entry_relative = relative.join(&name);
            entries.push(json!({
                "name": name_display,
                "relative_path": entry_relative.to_string_lossy(),
                "kind": if metadata.is_dir() { "directory" } else { "file" },
                "bytes": if metadata.is_file() { Some(metadata.len()) } else { None },
            }));
        }

        let truncated = match iterator.next() {
            Some(Ok(_)) => true,
            Some(Err(error)) => {
                return Err(format!("Failed to read directory entry: {}", error));
            }
            None => false,
        };
        Ok(BoundedDirectoryList {
            entries,
            skipped,
            scanned,
            truncated,
        })
    }

    fn atomic_write_bytes(target: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
        let parent = target
            .parent()
            .ok_or_else(|| "Artifact target has no parent directory".to_string())?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("Failed to create staged artifact: {}", error))?;
        staged
            .write_all(bytes)
            .map_err(|error| format!("Failed to stage artifact: {}", error))?;
        staged
            .as_file_mut()
            .sync_all()
            .map_err(|error| format!("Failed to sync staged artifact: {}", error))?;

        // Re-check the destination immediately before the atomic replacement.
        match fs::symlink_metadata(target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Refusing to replace a symlink or non-file artifact".to_string());
                }
                if !overwrite {
                    return Err("Artifact already exists and overwrite=false".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect artifact target: {}", error)),
        }

        if overwrite {
            staged.persist(target).map_err(|error| {
                format!("Failed to atomically replace artifact: {}", error.error)
            })?;
        } else {
            staged.persist_noclobber(target).map_err(|error| {
                format!("Failed to atomically create artifact: {}", error.error)
            })?;
        }
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    async fn execute_file_list(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) =
            Self::resolve_root(args.get("root_id").and_then(|v| v.as_str()), ctx)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        Self::ensure_public_runtime_path(&relative)?;
        let max_entries = args
            .get("max_entries")
            .and_then(|v| v.as_u64())
            .unwrap_or(200)
            .clamp(1, 500) as usize;
        let target = Self::ensure_inside_existing(&root_canon, &relative)?;
        let metadata = fs::metadata(&target).map_err(|e| format!("Failed to read path: {}", e))?;
        if !metadata.is_dir() {
            return Err("workspace_file_list path must be a directory".to_string());
        }

        let listed = Self::list_directory_bounded(&target, &relative, max_entries)?;

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "entries": listed.entries,
            "skipped": listed.skipped,
            "scanned": listed.scanned,
            "truncated": listed.truncated,
        }))
    }

    async fn execute_file_read(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) =
            Self::resolve_root(args.get("root_id").and_then(|v| v.as_str()), ctx)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        if relative.as_os_str().is_empty() {
            return Err("path is required".to_string());
        }
        Self::ensure_public_runtime_path(&relative)?;
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(64 * 1024)
            .clamp(1, 1024 * 1024) as usize;
        let target = Self::ensure_inside_existing(&root_canon, &relative)?;
        let read = Self::read_file_bounded(&target, max_bytes)?;
        let content = Self::decode_utf8_prefix(&read.visible, read.truncated)?;

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "content": content,
            "bytes": read.bytes,
            "sha256": read.sha256,
            "truncated": read.truncated,
        }))
    }

    async fn execute_artifact_write(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _mutation_guard = artifact_mutation_guard();
        let (root, root_canon) = Self::resolve_root(Some("artifacts"), ctx)?;
        let relative = Self::normalize_relative_path(args.get("path").and_then(|v| v.as_str()))?;
        Self::ensure_public_runtime_path(&relative)?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required")?;
        let overwrite = args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if content.len() > MAX_ARTIFACT_WRITE_BYTES {
            return Err(format!(
                "Artifact content exceeds the {} MiB write limit",
                MAX_ARTIFACT_WRITE_BYTES / (1024 * 1024)
            ));
        }
        let target = Self::ensure_write_target(&root, &root_canon, &relative)?;
        let existed = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Existing artifact must be a regular file".to_string());
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("Failed to inspect artifact target: {}", error)),
        };
        if existed && !overwrite {
            return Err("Artifact already exists and overwrite=false".to_string());
        }
        let file_name = relative
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| relative.to_string_lossy().to_string());
        // 覆盖已存在文件前先把旧内容备份到 temp 根备份区；备份失败则整个写入中止，
        // 保证只要返回了 modified change，就一定有可用的 backup_ref 供撤销恢复。
        let backup = if existed {
            let temp = temp_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
            let snapshot = create_write_backup_from_file(&temp.path, &file_name, &target)?;
            Some((temp.path, snapshot))
        } else {
            None
        };

        if let Err(error) = Self::atomic_write_bytes(&target, content.as_bytes(), overwrite) {
            if let Some((temp_path, snapshot)) = &backup {
                let _ = fs::remove_file(temp_path.join(&snapshot.backup_ref));
            }
            return Err(error);
        }
        let after_hash = Self::sha256_hex(content.as_bytes());
        let after_bytes = content.len();
        let op = if existed { "modified" } else { "created" };

        let mut change = json!({
            "op": op,
            "root_id": root.id.clone(),
            "relative_path": relative.to_string_lossy(),
            "before_hash": backup.as_ref().map(|(_, snapshot)| snapshot.sha256.clone()),
            "after_hash": after_hash.clone(),
            "bytes": after_bytes,
        });
        // backup_ref 仅在覆盖写时出现，None 时不落 key，保持旧前端向后兼容
        if let Some((_, snapshot)) = &backup {
            change["backup_ref"] = json!(snapshot.backup_ref);
        }

        Ok(json!({
            "root": Self::root_json(&root),
            "root_id": root.id.clone(),
            "path": relative.to_string_lossy(),
            "file_name": file_name,
            "bytes_written": after_bytes,
            "sha256": after_hash,
            "file_change_summary": {
                "created": if existed { 0 } else { 1 },
                "modified": if existed { 1 } else { 0 },
                "deleted": 0,
                "bytes_written": after_bytes,
                "changes": [change]
            }
        }))
    }

    async fn execute_workspace_write(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) = Self::resolve_root(Some("workspace"), ctx)?;
        Self::ensure_writable_workspace(&root)?;
        let path = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "path is required".to_string())?;
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| "content is required".to_string())?;
        if content.len() > MAX_ARTIFACT_WRITE_BYTES {
            return Err(format!(
                "Workspace content exceeds the {} MiB write limit",
                MAX_ARTIFACT_WRITE_BYTES / (1024 * 1024)
            ));
        }
        let expected = args.get("expected_current_hash").and_then(Value::as_str);
        let temp = temp_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
        let receipt = workspace_change_set::write_text(
            &root_canon,
            &temp.path,
            &root.id,
            path,
            content,
            expected,
        )?;
        Self::workspace_change_output(&root, receipt)
    }

    async fn execute_workspace_move(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) = Self::resolve_root(Some("workspace"), ctx)?;
        Self::ensure_writable_workspace(&root)?;
        let source = args
            .get("source_path")
            .and_then(Value::as_str)
            .ok_or_else(|| "source_path is required".to_string())?;
        let destination = args
            .get("destination_path")
            .and_then(Value::as_str)
            .ok_or_else(|| "destination_path is required".to_string())?;
        let expected = args
            .get("expected_current_hash")
            .and_then(Value::as_str)
            .ok_or_else(|| "expected_current_hash is required".to_string())?;
        let receipt =
            workspace_change_set::move_file(&root_canon, &root.id, source, destination, expected)?;
        Self::workspace_change_output(&root, receipt)
    }

    async fn execute_workspace_delete(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) = Self::resolve_root(Some("workspace"), ctx)?;
        Self::ensure_writable_workspace(&root)?;
        let path = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "path is required".to_string())?;
        let expected = args
            .get("expected_current_hash")
            .and_then(Value::as_str)
            .ok_or_else(|| "expected_current_hash is required".to_string())?;
        let temp = temp_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
        let receipt =
            workspace_change_set::delete_file(&root_canon, &temp.path, &root.id, path, expected)?;
        Self::workspace_change_output(&root, receipt)
    }

    async fn execute_workspace_revert(
        &self,
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let (root, root_canon) = Self::resolve_root(Some("workspace"), ctx)?;
        Self::ensure_writable_workspace(&root)?;
        let temp = temp_root(&ctx.window.app_handle(), &ctx.session_id, true)?;
        if let Some(value) = args.get("change_set") {
            let change_set: ChangeSet = serde_json::from_value(value.clone())
                .map_err(|error| format!("Invalid workspace change set: {}", error))?;
            if change_set
                .changes
                .iter()
                .any(|receipt| receipt.root_id != root.id)
            {
                return Err("Change set contains a different runtime root".to_string());
            }
            workspace_change_set::rollback_change_set(&root_canon, &temp.path, &change_set)?;
            return Ok(json!({
                "reverted": true,
                "root": Self::root_json(&root),
                "change_id": change_set.id,
                "change_set": change_set,
            }));
        }

        let receipt: MutationReceipt = serde_json::from_value(
            args.get("receipt")
                .cloned()
                .ok_or_else(|| "receipt or change_set is required".to_string())?,
        )
        .map_err(|error| format!("Invalid workspace mutation receipt: {}", error))?;
        if receipt.root_id != root.id {
            return Err("Mutation receipt belongs to a different runtime root".to_string());
        }
        workspace_change_set::rollback(&root_canon, &temp.path, &receipt)?;
        Ok(json!({
            "reverted": true,
            "root": Self::root_json(&root),
            "change_id": receipt.change_id,
            "receipt": receipt,
        }))
    }

    fn workspace_change_output(
        root: &RuntimeRoot,
        receipt: MutationReceipt,
    ) -> Result<Value, String> {
        let created = usize::from(receipt.op == MutationKind::Created);
        let modified = usize::from(matches!(
            receipt.op,
            MutationKind::Modified | MutationKind::Moved
        ));
        let deleted = usize::from(receipt.op == MutationKind::Deleted);
        let bytes_written = if deleted > 0 { 0 } else { receipt.bytes };
        let change_set = ChangeSet::single(receipt.clone());
        Ok(json!({
            "root": Self::root_json(root),
            "root_id": root.id,
            "change_set": change_set,
            "mutation_receipt": receipt,
            "file_change_summary": {
                "created": created,
                "modified": modified,
                "deleted": deleted,
                "bytes_written": bytes_written,
                "changes": change_set.changes,
            }
        }))
    }
}

#[async_trait]
impl ToolExecutor for WorkspaceFsExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::FILE_LIST
                | tool_names::FILE_READ
                | tool_names::ARTIFACT_WRITE
                | tool_names::FILE_WRITE
                | tool_names::FILE_MOVE
                | tool_names::FILE_DELETE
                | tool_names::CHANGE_REVERT
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
            tool_names::FILE_WRITE => self.execute_workspace_write(&call.arguments, ctx).await,
            tool_names::FILE_MOVE => self.execute_workspace_move(&call.arguments, ctx).await,
            tool_names::FILE_DELETE => self.execute_workspace_delete(&call.arguments, ctx).await,
            tool_names::CHANGE_REVERT => self.execute_workspace_revert(&call.arguments, ctx).await,
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
            tool_names::ARTIFACT_WRITE | tool_names::FILE_WRITE => ToolSensitivity::Medium,
            tool_names::FILE_MOVE | tool_names::FILE_DELETE | tool_names::CHANGE_REVERT => {
                ToolSensitivity::High
            }
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
        let unsafe_id = crate::chat_v2::runtime_roots::safe_session_dir("sess:abc/123");
        let formerly_colliding = crate::chat_v2::runtime_roots::safe_session_dir("sess_abc_123");
        assert!(unsafe_id.starts_with("v2-sess_abc_123-"));
        assert_ne!(unsafe_id, formerly_colliding);
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

    #[test]
    fn hidden_and_secret_paths_are_private_by_default() {
        for path in [
            ".env",
            ".npmrc",
            ".ssh/id_ed25519",
            "config/credentials.json",
            "keys/server.pem",
            "auth/private_key.txt",
        ] {
            assert!(
                WorkspaceFsExecutor::ensure_public_runtime_path(Path::new(path)).is_err(),
                "expected private path rejection for {path}"
            );
        }
        assert!(WorkspaceFsExecutor::ensure_public_runtime_path(Path::new(
            "notes/semester-plan.md"
        ))
        .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn existing_path_resolution_rejects_symlinked_private_targets() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        fs::write(temp_dir.path().join(".env"), "SECRET=value").expect("secret");
        symlink(
            temp_dir.path().join(".env"),
            temp_dir.path().join("public.txt"),
        )
        .expect("symlink");
        let root_canon = temp_dir.path().canonicalize().expect("canonical root");

        let error =
            WorkspaceFsExecutor::ensure_inside_existing(&root_canon, Path::new("public.txt"))
                .expect_err("symlink must be rejected");
        assert!(error.contains("symlink"));
    }

    #[test]
    fn directory_list_stops_after_requested_limit() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        for index in 0..50 {
            fs::write(temp_dir.path().join(format!("file-{index:03}.txt")), "x")
                .expect("write file");
        }

        let listed = WorkspaceFsExecutor::list_directory_bounded(temp_dir.path(), Path::new(""), 5)
            .expect("list");
        assert_eq!(listed.entries.len(), 5);
        assert!(listed.truncated);
        assert!(listed.scanned <= 20);
    }

    #[test]
    fn directory_list_filters_hidden_and_secret_entries() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        fs::write(temp_dir.path().join("visible.txt"), "ok").expect("visible");
        fs::write(temp_dir.path().join(".env"), "secret").expect("hidden");
        fs::write(temp_dir.path().join("credentials.json"), "secret").expect("credentials");

        let listed =
            WorkspaceFsExecutor::list_directory_bounded(temp_dir.path(), Path::new(""), 10)
                .expect("list");
        let names = listed
            .entries
            .iter()
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["visible.txt"]);
        assert_eq!(listed.skipped, 2);
        assert!(!listed.truncated);
    }

    #[test]
    fn file_read_streams_full_hash_but_keeps_only_visible_prefix() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let target = temp_dir.path().join("unicode.txt");
        let content = "ab你cd";
        fs::write(&target, content).expect("write");

        let read = WorkspaceFsExecutor::read_file_bounded(&target, 4).expect("read");
        assert_eq!(read.bytes, content.len() as u64);
        assert_eq!(read.visible.len(), 4);
        assert!(read.truncated);
        assert_eq!(
            read.sha256,
            WorkspaceFsExecutor::sha256_hex(content.as_bytes())
        );
        assert_eq!(
            WorkspaceFsExecutor::decode_utf8_prefix(&read.visible, read.truncated).unwrap(),
            "ab"
        );
    }

    #[test]
    fn file_read_rejects_oversized_sparse_files_before_allocating() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let target = temp_dir.path().join("oversized.txt");
        let file = fs::File::create(&target).expect("create");
        file.set_len(MAX_FILE_SOURCE_BYTES + 1).expect("set length");
        assert!(WorkspaceFsExecutor::read_file_bounded(&target, 1024).is_err());
    }

    #[test]
    fn atomic_write_replaces_or_preserves_existing_content() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let target = temp_dir.path().join("artifact.md");
        fs::write(&target, "old").expect("old");

        WorkspaceFsExecutor::atomic_write_bytes(&target, b"new", true).expect("replace");
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");

        assert!(WorkspaceFsExecutor::atomic_write_bytes(&target, b"unexpected", false).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }
}
