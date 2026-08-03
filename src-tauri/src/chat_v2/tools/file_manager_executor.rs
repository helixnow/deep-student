use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use uuid::Uuid;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    artifact_mutation_guard, normalize_runtime_relative_path, revalidate_runtime_root,
    runtime_root_by_id, RuntimeRoot, RuntimeRootAccess, RuntimeRootKind,
};
use crate::chat_v2::task_objects::{
    BatchItemStatus, BatchManifest, BatchManifestItem, ManagedLocator, ObjectCapabilities,
    ObjectProvenance, TaskObjectHandle, TaskObjectKind,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub mod tool_names {
    pub const PLAN: &str = "file_manager_plan";
    pub const COMMIT: &str = "file_manager_commit";
    pub const RESTORE: &str = "file_manager_restore";
}

const PLAN_TTL_MINUTES: i64 = 10;
const MAX_BATCH_ITEMS: usize = 100;
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONVERT_BYTES: u64 = 16 * 1024 * 1024;
const TRASH_DIR: &str = ".deep-student-trash";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FileOperation {
    Rename,
    Move,
    Delete,
    FormatConvert,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ConvertFormat {
    JsonPretty,
    JsonCompact,
    CsvToTsv,
    TsvToCsv,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct RequestedItem {
    item_id: String,
    operation: FileOperation,
    source_path: String,
    destination_path: Option<String>,
    format: Option<ConvertFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlannedItem {
    item_id: String,
    operation: FileOperation,
    source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<ConvertFormat>,
    expected_current_hash: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanPreview {
    schema_version: u16,
    root_id: String,
    items: Vec<PlannedItem>,
}

#[derive(Debug, Clone)]
struct PlanRecord {
    plan_id: String,
    session_id: String,
    root_id: String,
    root_path: PathBuf,
    preview: PlanPreview,
    preview_sha256: String,
    created_at: chrono::DateTime<Utc>,
    expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RestoreReceipt {
    receipt_id: String,
    plan_id: String,
    item_id: String,
    session_id: String,
    root_id: String,
    original_path: String,
    trash_path: String,
    sha256: String,
    deleted_at: String,
}

fn plans() -> &'static Mutex<HashMap<String, PlanRecord>> {
    static PLANS: OnceLock<Mutex<HashMap<String, PlanRecord>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn restore_receipts() -> &'static Mutex<HashMap<String, RestoreReceipt>> {
    static RECEIPTS: OnceLock<Mutex<HashMap<String, RestoreReceipt>>> = OnceLock::new();
    RECEIPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct FileManagerExecutor;

impl Default for FileManagerExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl FileManagerExecutor {
    pub fn new() -> Self {
        Self
    }

    fn resolve_workspace(
        ctx: &ExecutionContext,
        root_id: &str,
    ) -> Result<(RuntimeRoot, PathBuf), String> {
        if root_id != "workspace" {
            return Err("File manager mutations require root_id=workspace; authorized roots remain read-only".to_string());
        }
        let state = ctx.window_ref().state::<AppState>();
        let root = runtime_root_by_id(
            ctx.window_ref().app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            Some(root_id),
            false,
        )?;
        if root.kind != RuntimeRootKind::Workspace
            || root.access != RuntimeRootAccess::ReadWrite
            || !root.configured
        {
            return Err(
                "File manager requires an explicitly configured read-write workspace".to_string(),
            );
        }
        let canonical = revalidate_runtime_root(&state.database, &root)?;
        Ok((root, canonical))
    }

    fn normalize_file_path(raw: &str, field: &str) -> Result<String, String> {
        if raw.contains('\\') {
            return Err(format!("{field} must use forward slashes"));
        }
        let path = normalize_runtime_relative_path(Some(raw))?;
        if path.as_os_str().is_empty() {
            return Err(format!("{field} must be a non-empty relative path"));
        }
        for component in path.components() {
            let std::path::Component::Normal(value) = component else {
                continue;
            };
            let text = value.to_string_lossy();
            if text.starts_with('.') {
                return Err(format!("{field} cannot address hidden workspace paths"));
            }
        }
        Ok(path.to_string_lossy().to_string())
    }

    fn existing_regular_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
        let relative_path = Path::new(relative);
        let mut current = root.to_path_buf();
        for component in relative_path.components() {
            let std::path::Component::Normal(value) = component else {
                continue;
            };
            current.push(value);
            let metadata = fs::symlink_metadata(&current)
                .map_err(|error| format!("Cannot inspect '{}': {}", relative, error))?;
            if metadata.file_type().is_symlink() {
                return Err(format!("Symlinks are not supported: {}", relative));
            }
        }
        let canonical = current
            .canonicalize()
            .map_err(|error| format!("Cannot resolve '{}': {}", relative, error))?;
        if !canonical.starts_with(root) {
            return Err("Path escapes the selected runtime root".to_string());
        }
        let metadata = canonical
            .metadata()
            .map_err(|error| format!("Cannot inspect '{}': {}", relative, error))?;
        if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "Source must be a regular file no larger than {} MiB",
                MAX_SOURCE_BYTES / 1024 / 1024
            ));
        }
        Ok(canonical)
    }

    fn safe_destination(root: &Path, relative: &str) -> Result<PathBuf, String> {
        let relative_path = Path::new(relative);
        let parent_relative = relative_path.parent().unwrap_or_else(|| Path::new(""));
        Self::check_destination_ancestors(root, parent_relative)?;
        Ok(root.join(relative_path))
    }

    fn check_destination_ancestors(root: &Path, parent_relative: &Path) -> Result<(), String> {
        let mut current = root.to_path_buf();
        for component in parent_relative.components() {
            let std::path::Component::Normal(value) = component else {
                continue;
            };
            current.push(value);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err("Destination parents cannot contain symlinks".to_string());
                    }
                    if !metadata.is_dir() {
                        return Err("Destination parent component is not a directory".to_string());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(format!("Cannot inspect destination parent: {}", error)),
            }
        }
        let nearest_existing = current
            .ancestors()
            .find(|candidate| candidate.exists())
            .ok_or_else(|| "Destination has no existing workspace ancestor".to_string())?;
        let canonical = nearest_existing
            .canonicalize()
            .map_err(|error| format!("Cannot resolve destination ancestor: {}", error))?;
        if !canonical.starts_with(root) {
            return Err("Destination escapes the selected runtime root".to_string());
        }
        Ok(())
    }

    fn hash_file(path: &Path) -> Result<(String, u64), String> {
        let mut file =
            File::open(path).map_err(|error| format!("Cannot open source: {}", error))?;
        let mut hasher = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("Cannot read source: {}", error))?;
            if read == 0 {
                break;
            }
            bytes += read as u64;
            hasher.update(&buffer[..read]);
        }
        Ok((hex::encode(hasher.finalize()), bytes))
    }

    fn sha256_json<T: Serialize>(value: &T) -> Result<String, String> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| format!("Cannot serialize preview: {}", error))?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }

    fn validate_requested_item(item: RequestedItem, root: &Path) -> Result<PlannedItem, String> {
        if item.item_id.trim().is_empty() || item.item_id != item.item_id.trim() {
            return Err("item_id must be non-empty and normalized".to_string());
        }
        let source = Self::normalize_file_path(&item.source_path, "source_path")?;
        let source_abs = Self::existing_regular_file(root, &source)?;
        let (expected_current_hash, size_bytes) = Self::hash_file(&source_abs)?;

        let destination = match item.operation {
            FileOperation::Delete => {
                if item.destination_path.is_some() || item.format.is_some() {
                    return Err("delete does not accept destination_path or format".to_string());
                }
                None
            }
            FileOperation::Rename | FileOperation::Move | FileOperation::FormatConvert => {
                let raw = item
                    .destination_path
                    .as_deref()
                    .ok_or_else(|| "destination_path is required".to_string())?;
                let normalized = Self::normalize_file_path(raw, "destination_path")?;
                if normalized == source {
                    return Err("source_path and destination_path must differ".to_string());
                }
                let destination_abs = Self::safe_destination(root, &normalized)?;
                if destination_abs.exists() {
                    return Err(format!("Destination already exists: {}", normalized));
                }
                if item.operation == FileOperation::Rename
                    && Path::new(&source).parent() != Path::new(&normalized).parent()
                {
                    return Err("rename must keep the file in the same directory; use move across directories".to_string());
                }
                if item.operation == FileOperation::Move
                    && Path::new(&source).parent() == Path::new(&normalized).parent()
                {
                    return Err(
                        "move must change directories; use rename within one directory".to_string(),
                    );
                }
                Some(normalized)
            }
        };
        match item.operation {
            FileOperation::FormatConvert if item.format.is_none() => {
                return Err("format is required for format_convert".to_string())
            }
            FileOperation::FormatConvert if size_bytes > MAX_CONVERT_BYTES => {
                return Err(format!(
                    "Format conversion is limited to {} MiB",
                    MAX_CONVERT_BYTES / 1024 / 1024
                ))
            }
            FileOperation::Rename | FileOperation::Move if item.format.is_some() => {
                return Err("format is only valid for format_convert".to_string())
            }
            _ => {}
        }
        Ok(PlannedItem {
            item_id: item.item_id,
            operation: item.operation,
            source_path: source,
            destination_path: destination,
            format: item.format,
            expected_current_hash,
            size_bytes,
        })
    }

    fn plan(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let root_id = args
            .get("root_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "root_id is required".to_string())?;
        let (_root, root_path) = Self::resolve_workspace(ctx, root_id)?;
        let requested: Vec<RequestedItem> = serde_json::from_value(
            args.get("items")
                .cloned()
                .ok_or_else(|| "items is required".to_string())?,
        )
        .map_err(|error| format!("Invalid file manager items: {}", error))?;
        if requested.is_empty() || requested.len() > MAX_BATCH_ITEMS {
            return Err(format!(
                "items must contain 1..={} entries",
                MAX_BATCH_ITEMS
            ));
        }
        let mut item_ids = HashSet::new();
        let mut sources = HashSet::new();
        let mut destinations = HashSet::new();
        let mut items = Vec::with_capacity(requested.len());
        for requested_item in requested {
            let item = Self::validate_requested_item(requested_item, &root_path)?;
            if !item_ids.insert(item.item_id.clone()) {
                return Err(format!("Duplicate item_id: {}", item.item_id));
            }
            if !sources.insert(item.source_path.clone()) {
                return Err(format!("Duplicate source_path: {}", item.source_path));
            }
            if let Some(destination) = &item.destination_path {
                if !destinations.insert(destination.clone()) {
                    return Err(format!("Duplicate destination_path: {}", destination));
                }
            }
            items.push(item);
        }
        if destinations.iter().any(|path| sources.contains(path)) {
            return Err("A batch destination cannot also be a batch source".to_string());
        }
        let preview = PlanPreview {
            schema_version: 1,
            root_id: root_id.to_string(),
            items,
        };
        let preview_sha256 = Self::sha256_json(&preview)?;
        let now = Utc::now();
        let record = PlanRecord {
            plan_id: format!("fileplan_{}", Uuid::new_v4()),
            session_id: ctx.session_id.clone(),
            root_id: root_id.to_string(),
            root_path,
            preview: preview.clone(),
            preview_sha256: preview_sha256.clone(),
            created_at: now,
            expires_at: now + Duration::minutes(PLAN_TTL_MINUTES),
        };
        plans()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, value| value.expires_at > now);
        plans()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(record.plan_id.clone(), record.clone());
        Ok(json!({
            "plan_id": record.plan_id,
            "root_id": record.root_id,
            "preview": preview,
            "preview_sha256": preview_sha256,
            "created_at": record.created_at.to_rfc3339(),
            "expires_at": record.expires_at.to_rfc3339(),
            "ttl_seconds": PLAN_TTL_MINUTES * 60,
        }))
    }

    fn take_matching_plan(args: &Value, ctx: &ExecutionContext) -> Result<PlanRecord, String> {
        let plan_id = args
            .get("plan_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "plan_id is required".to_string())?;
        let observed_hash = args
            .get("preview_sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| "preview_sha256 is required".to_string())?;
        let root_id = args
            .get("root_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "root_id is required".to_string())?;
        let now = Utc::now();
        let mut cache = plans().lock().unwrap_or_else(|p| p.into_inner());
        cache.retain(|_, value| value.expires_at > now);
        let record = cache.get(plan_id).cloned().ok_or_else(|| {
            "File manager plan is missing, expired, or already committed; create a new plan"
                .to_string()
        })?;
        if record.session_id != ctx.session_id || record.root_id != root_id {
            return Err(
                "File manager plan belongs to a different session or runtime root".to_string(),
            );
        }
        if record.preview_sha256 != observed_hash {
            return Err("File manager preview hash does not match the reviewed plan".to_string());
        }
        cache.remove(plan_id);
        Ok(record)
    }

    fn ensure_parent(root: &Path, destination: &Path) -> Result<(), String> {
        let parent = destination
            .parent()
            .ok_or_else(|| "Destination has no parent".to_string())?;
        let parent_relative = parent
            .strip_prefix(root)
            .map_err(|_| "Destination escapes the selected runtime root".to_string())?;
        Self::check_destination_ancestors(root, parent_relative)?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create destination directory: {}", error))?;
        Self::check_destination_ancestors(root, parent_relative)?;
        let canonical = parent
            .canonicalize()
            .map_err(|error| format!("Cannot resolve destination parent: {}", error))?;
        if !canonical.starts_with(root) {
            return Err("Destination escapes the selected runtime root".to_string());
        }
        Ok(())
    }

    fn atomic_create(path: &Path, content: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Destination has no parent".to_string())?;
        let temp = parent.join(format!(".deep-student-convert-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|error| format!("Cannot create temporary output: {}", error))?;
            file.write_all(content)
                .map_err(|error| format!("Cannot write output: {}", error))?;
            file.sync_all()
                .map_err(|error| format!("Cannot sync output: {}", error))?;
            if path.exists() {
                return Err("Destination appeared after planning".to_string());
            }
            fs::rename(&temp, path).map_err(|error| format!("Cannot commit output: {}", error))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn convert_content(path: &Path, format: ConvertFormat) -> Result<Vec<u8>, String> {
        let bytes =
            fs::read(path).map_err(|error| format!("Cannot read conversion source: {}", error))?;
        match format {
            ConvertFormat::JsonPretty | ConvertFormat::JsonCompact => {
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("Invalid JSON source: {}", error))?;
                if format == ConvertFormat::JsonPretty {
                    serde_json::to_vec_pretty(&value)
                        .map_err(|error| format!("Cannot encode JSON: {}", error))
                } else {
                    serde_json::to_vec(&value)
                        .map_err(|error| format!("Cannot encode JSON: {}", error))
                }
            }
            ConvertFormat::CsvToTsv | ConvertFormat::TsvToCsv => {
                let (input_delimiter, output_delimiter) = if format == ConvertFormat::CsvToTsv {
                    (b',', b'\t')
                } else {
                    (b'\t', b',')
                };
                let mut reader = csv::ReaderBuilder::new()
                    .delimiter(input_delimiter)
                    .has_headers(false)
                    .from_reader(bytes.as_slice());
                let mut writer = csv::WriterBuilder::new()
                    .delimiter(output_delimiter)
                    .from_writer(Vec::new());
                for record in reader.records() {
                    let record =
                        record.map_err(|error| format!("Invalid delimited source: {}", error))?;
                    writer
                        .write_record(&record)
                        .map_err(|error| format!("Cannot encode converted data: {}", error))?;
                }
                writer
                    .into_inner()
                    .map_err(|error| format!("Cannot finalize converted data: {}", error))
            }
        }
    }

    fn object_handle(
        item: &PlannedItem,
        relative_path: &str,
        hash: String,
        bytes: u64,
    ) -> Result<TaskObjectHandle, String> {
        let display_name = Path::new(relative_path)
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| relative_path.to_string());
        let mut handle = TaskObjectHandle::new(
            format!("fileobj_{}", Uuid::new_v4()),
            TaskObjectKind::File,
            display_name,
            ObjectProvenance {
                source: "file_manager".to_string(),
                source_uri: None,
                server: None,
                tool: Some(tool_names::COMMIT.to_string()),
                derived_from: vec![item.source_path.clone()],
                observed_at: Utc::now().to_rfc3339(),
            },
        );
        handle.sha256 = Some(hash);
        handle.size_bytes = Some(bytes);
        handle.locator = Some(ManagedLocator::new("workspace", relative_path)?);
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

    fn commit_item(
        root: &Path,
        plan_id: &str,
        item: &PlannedItem,
        session_id: &str,
    ) -> Result<(TaskObjectHandle, Option<RestoreReceipt>, Value), String> {
        let source = Self::existing_regular_file(root, &item.source_path)?;
        let (observed_hash, observed_bytes) = Self::hash_file(&source)?;
        if observed_hash != item.expected_current_hash || observed_bytes != item.size_bytes {
            return Err(format!(
                "OCC conflict: '{}' changed after planning",
                item.source_path
            ));
        }
        match item.operation {
            FileOperation::Rename | FileOperation::Move => {
                let destination_path = item
                    .destination_path
                    .as_deref()
                    .expect("validated destination");
                let destination = Self::safe_destination(root, destination_path)?;
                if destination.exists() {
                    return Err("Destination appeared after planning".to_string());
                }
                Self::ensure_parent(root, &destination)?;
                fs::rename(&source, &destination)
                    .map_err(|error| format!("Cannot move file: {}", error))?;
                let handle = Self::object_handle(
                    item,
                    destination_path,
                    observed_hash.clone(),
                    observed_bytes,
                )?;
                Ok((
                    handle,
                    None,
                    json!({ "op": "moved", "root_id": "workspace", "relative_path": item.source_path, "destination_path": destination_path, "before_hash": observed_hash, "after_hash": observed_hash, "bytes": observed_bytes }),
                ))
            }
            FileOperation::FormatConvert => {
                let destination_path = item
                    .destination_path
                    .as_deref()
                    .expect("validated destination");
                let destination = Self::safe_destination(root, destination_path)?;
                if destination.exists() {
                    return Err("Destination appeared after planning".to_string());
                }
                Self::ensure_parent(root, &destination)?;
                let content =
                    Self::convert_content(&source, item.format.expect("validated format"))?;
                Self::atomic_create(&destination, &content)?;
                let converted_hash = hex::encode(Sha256::digest(&content));
                let handle = Self::object_handle(
                    item,
                    destination_path,
                    converted_hash.clone(),
                    content.len() as u64,
                )?;
                Ok((
                    handle,
                    None,
                    json!({ "op": "created", "root_id": "workspace", "relative_path": destination_path, "before_hash": Value::Null, "after_hash": converted_hash, "bytes": content.len() }),
                ))
            }
            FileOperation::Delete => {
                let trash_relative = format!("{}/{}/{}", TRASH_DIR, plan_id, item.source_path);
                let trash = root.join(&trash_relative);
                if trash.exists() {
                    return Err("Internal trash destination already exists".to_string());
                }
                Self::ensure_parent(root, &trash)?;
                fs::rename(&source, &trash)
                    .map_err(|error| format!("Cannot move file to workspace trash: {}", error))?;
                let receipt = RestoreReceipt {
                    receipt_id: format!("restore_{}", Uuid::new_v4()),
                    plan_id: plan_id.to_string(),
                    item_id: item.item_id.clone(),
                    session_id: session_id.to_string(),
                    root_id: "workspace".to_string(),
                    original_path: item.source_path.clone(),
                    trash_path: trash_relative.clone(),
                    sha256: observed_hash.clone(),
                    deleted_at: Utc::now().to_rfc3339(),
                };
                let mut handle = Self::object_handle(
                    item,
                    &trash_relative,
                    observed_hash.clone(),
                    observed_bytes,
                )?;
                handle.capabilities = ObjectCapabilities::default();
                Ok((
                    handle,
                    Some(receipt),
                    json!({ "op": "deleted", "root_id": "workspace", "relative_path": item.source_path, "trash_path": trash_relative, "before_hash": observed_hash, "after_hash": Value::Null, "bytes": observed_bytes }),
                ))
            }
        }
    }

    fn commit(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let record = Self::take_matching_plan(args, ctx)?;
        let (_root, root_path) = Self::resolve_workspace(ctx, &record.root_id)?;
        if root_path != record.root_path {
            return Err("Workspace root binding changed after planning".to_string());
        }
        let _guard = artifact_mutation_guard();
        let mut manifest_items = Vec::with_capacity(record.preview.items.len());
        let mut objects = Vec::new();
        let mut receipts = Vec::new();
        let mut changes = Vec::new();
        for item in &record.preview.items {
            match Self::commit_item(&root_path, &record.plan_id, item, &ctx.session_id) {
                Ok((handle, receipt, change)) => {
                    let handle_id = handle.handle_id.clone();
                    if let Some(receipt) = receipt {
                        restore_receipts()
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .insert(receipt.receipt_id.clone(), receipt.clone());
                        receipts.push(receipt);
                    }
                    changes.push(change);
                    objects.push(handle);
                    manifest_items.push(BatchManifestItem {
                        item_id: item.item_id.clone(),
                        object_handle_id: Some(handle_id),
                        status: BatchItemStatus::Succeeded,
                        attempts: 1,
                        error: None,
                    });
                }
                Err(error) => manifest_items.push(BatchManifestItem {
                    item_id: item.item_id.clone(),
                    object_handle_id: None,
                    status: BatchItemStatus::Failed,
                    attempts: 1,
                    error: Some(error),
                }),
            }
        }
        let manifest = BatchManifest {
            manifest_id: format!("manifest_{}", Uuid::new_v4()),
            expected_items: record.preview.items.len() as u64,
            observed_items: manifest_items.len() as u64,
            coverage_complete: manifest_items.len() == record.preview.items.len(),
            truncated: false,
            items: manifest_items,
        };
        let complete = manifest.can_claim_complete_success();
        let created = changes
            .iter()
            .filter(|v| v.get("op") == Some(&Value::String("created".to_string())))
            .count();
        let moved = changes
            .iter()
            .filter(|v| v.get("op") == Some(&Value::String("moved".to_string())))
            .count();
        let deleted = changes
            .iter()
            .filter(|v| v.get("op") == Some(&Value::String("deleted".to_string())))
            .count();
        Ok(json!({
            "complete": complete,
            "transactional": false,
            "rollbackCoverage": {
                "automatic": false,
                "softDeleteItems": receipts.len(),
                "note": "Successful items remain committed; only soft-delete items have restore receipts"
            },
            "plan_id": record.plan_id,
            "root_id": record.root_id,
            "preview_sha256": record.preview_sha256,
            "batch_manifest": manifest,
            "task_objects": objects,
            "restore_receipts": receipts,
            "file_change_summary": { "created": created, "modified": moved, "deleted": deleted, "changes": changes },
        }))
    }

    fn restore(args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let supplied: RestoreReceipt = serde_json::from_value(
            args.get("receipt")
                .cloned()
                .ok_or_else(|| "receipt is required".to_string())?,
        )
        .map_err(|error| format!("Invalid restore receipt: {}", error))?;
        if supplied.session_id != ctx.session_id || supplied.root_id != "workspace" {
            return Err(
                "Restore receipt belongs to a different session or runtime root".to_string(),
            );
        }
        let receipt_cache = restore_receipts().lock().unwrap_or_else(|p| p.into_inner());
        let stored = receipt_cache.get(&supplied.receipt_id).cloned();
        if let Some(stored) = stored {
            if supplied != stored {
                return Err("Restore receipt does not match the issued receipt".to_string());
            }
        } else if receipt_cache.values().any(|issued| {
            issued.plan_id == supplied.plan_id
                && issued.item_id == supplied.item_id
                && issued.session_id == supplied.session_id
        }) {
            return Err("Restore receipt id does not match the issued receipt".to_string());
        }
        drop(receipt_cache);
        let (_root, root) = Self::resolve_workspace(ctx, &supplied.root_id)?;
        let expected_trash = format!(
            "{}/{}/{}",
            TRASH_DIR, supplied.plan_id, supplied.original_path
        );
        if supplied.trash_path != expected_trash {
            return Err("Restore receipt has an invalid backend trash path".to_string());
        }
        let _guard = artifact_mutation_guard();
        let trash = Self::existing_regular_file(&root, &supplied.trash_path)?;
        let (observed_hash, bytes) = Self::hash_file(&trash)?;
        if observed_hash != supplied.sha256 {
            return Err("OCC conflict: trashed file changed after deletion".to_string());
        }
        let destination = Self::safe_destination(&root, &supplied.original_path)?;
        if destination.exists() {
            return Err("Restore target already exists".to_string());
        }
        Self::ensure_parent(&root, &destination)?;
        fs::rename(&trash, &destination)
            .map_err(|error| format!("Cannot restore file: {}", error))?;
        restore_receipts()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&supplied.receipt_id);
        let planned = PlannedItem {
            item_id: supplied.item_id.clone(),
            operation: FileOperation::Delete,
            source_path: supplied.original_path.clone(),
            destination_path: None,
            format: None,
            expected_current_hash: supplied.sha256.clone(),
            size_bytes: bytes,
        };
        let mut handle = Self::object_handle(
            &planned,
            &supplied.original_path,
            supplied.sha256.clone(),
            bytes,
        )?;
        handle.provenance.tool = Some(tool_names::RESTORE.to_string());
        let manifest = BatchManifest {
            manifest_id: format!("manifest_{}", Uuid::new_v4()),
            expected_items: 1,
            observed_items: 1,
            coverage_complete: true,
            truncated: false,
            items: vec![BatchManifestItem {
                item_id: supplied.item_id,
                object_handle_id: Some(handle.handle_id.clone()),
                status: BatchItemStatus::Succeeded,
                attempts: 1,
                error: None,
            }],
        };
        Ok(json!({
            "complete": manifest.can_claim_complete_success(), "root_id": "workspace", "restored": supplied.original_path,
            "batch_manifest": manifest, "task_objects": [handle],
            "file_change_summary": { "created": 0, "modified": 1, "deleted": 0, "changes": [{ "op": "moved", "root_id": "workspace", "relative_path": supplied.trash_path, "destination_path": supplied.original_path, "before_hash": supplied.sha256, "after_hash": supplied.sha256, "bytes": bytes }] }
        }))
    }
}

#[async_trait]
impl ToolExecutor for FileManagerExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            strip_tool_namespace(tool_name),
            tool_names::PLAN | tool_names::COMMIT | tool_names::RESTORE
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = match strip_tool_namespace(&call.name) {
            tool_names::PLAN => Self::plan(&call.arguments, ctx),
            tool_names::COMMIT => Self::commit(&call.arguments, ctx),
            tool_names::RESTORE => Self::restore(&call.arguments, ctx),
            _ => Err("Unknown file manager tool".to_string()),
        };
        let duration = start.elapsed().as_millis() as u64;
        let info = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
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
                    duration,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&info) {
            log::warn!("[FileManagerExecutor] Failed to save tool block: {}", error);
        }
        Ok(info)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match strip_tool_namespace(tool_name) {
            tool_names::PLAN => ToolSensitivity::Low,
            tool_names::COMMIT | tool_names::RESTORE => ToolSensitivity::Medium,
            _ => ToolSensitivity::High,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if strip_tool_namespace(tool_name) == tool_names::PLAN {
            ToolConcurrency::ReadOnly
        } else {
            ToolConcurrency::Serial
        }
    }

    fn name(&self) -> &'static str {
        "FileManagerExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_rejects_absolute_escape_and_hidden_paths() {
        assert_eq!(
            FileManagerExecutor::normalize_file_path("reports/./a.json", "source").unwrap(),
            "reports/a.json"
        );
        for unsafe_path in [
            "../secret",
            "/tmp/file",
            ".env",
            "a/.hidden/file",
            "a\\..\\secret",
        ] {
            assert!(
                FileManagerExecutor::normalize_file_path(unsafe_path, "source").is_err(),
                "{unsafe_path}"
            );
        }
    }

    #[test]
    fn preview_hash_binds_expected_hashes_and_destination() {
        let mut preview = PlanPreview {
            schema_version: 1,
            root_id: "workspace".into(),
            items: vec![PlannedItem {
                item_id: "one".into(),
                operation: FileOperation::Rename,
                source_path: "a.txt".into(),
                destination_path: Some("b.txt".into()),
                format: None,
                expected_current_hash: "a".repeat(64),
                size_bytes: 1,
            }],
        };
        let first = FileManagerExecutor::sha256_json(&preview).unwrap();
        preview.items[0].destination_path = Some("c.txt".into());
        assert_ne!(first, FileManagerExecutor::sha256_json(&preview).unwrap());
        preview.items[0].destination_path = Some("b.txt".into());
        preview.items[0].expected_current_hash = "b".repeat(64);
        assert_ne!(first, FileManagerExecutor::sha256_json(&preview).unwrap());
    }

    #[test]
    fn delete_trash_path_is_backend_derived() {
        let requested: RequestedItem = serde_json::from_value(json!({ "item_id": "one", "operation": "delete", "source_path": "a.txt", "destination_path": "chosen/by/model" })).unwrap();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        assert!(FileManagerExecutor::validate_requested_item(requested, dir.path()).is_err());
    }

    #[test]
    fn conversions_are_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let json_path = dir.path().join("a.json");
        fs::write(&json_path, br#"{"b":2,"a":1}"#).unwrap();
        let pretty =
            FileManagerExecutor::convert_content(&json_path, ConvertFormat::JsonPretty).unwrap();
        assert_eq!(
            pretty,
            FileManagerExecutor::convert_content(&json_path, ConvertFormat::JsonPretty).unwrap()
        );
        assert!(String::from_utf8(pretty).unwrap().contains('\n'));
    }

    #[test]
    fn manifest_never_claims_partial_success() {
        let manifest = BatchManifest {
            manifest_id: "one".into(),
            expected_items: 2,
            observed_items: 2,
            coverage_complete: true,
            truncated: false,
            items: vec![
                BatchManifestItem {
                    item_id: "a".into(),
                    object_handle_id: None,
                    status: BatchItemStatus::Succeeded,
                    attempts: 1,
                    error: None,
                },
                BatchManifestItem {
                    item_id: "b".into(),
                    object_handle_id: None,
                    status: BatchItemStatus::Failed,
                    attempts: 1,
                    error: Some("conflict".into()),
                },
            ],
        };
        assert!(!manifest.can_claim_complete_success());
    }

    #[test]
    fn sensitivity_and_concurrency_match_product_contract() {
        let executor = FileManagerExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-file_manager_plan"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.concurrency_class("builtin-file_manager_plan"),
            ToolConcurrency::ReadOnly
        );
        for tool in [
            "builtin-file_manager_commit",
            "builtin-file_manager_restore",
        ] {
            assert_eq!(executor.sensitivity_level(tool), ToolSensitivity::Medium);
            assert_eq!(executor.concurrency_class(tool), ToolConcurrency::Serial);
        }
    }
}
