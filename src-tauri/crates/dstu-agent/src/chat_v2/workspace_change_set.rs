use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::chat_v2::runtime_roots::normalize_runtime_relative_path;

const MAX_MUTATION_BYTES: u64 = 64 * 1024 * 1024;
const CHECKPOINT_DIR: &str = ".workspace_changes";
static CHANGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static WORKSPACE_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationKind {
    Created,
    Modified,
    Moved,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationReceipt {
    pub change_id: String,
    pub root_id: String,
    pub op: MutationKind,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_ref: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    pub id: String,
    pub changes: Vec<MutationReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollbackItemResult {
    pub change_id: String,
    pub relative_path: String,
    pub reverted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollbackChangeSetResult {
    pub change_set_id: String,
    pub complete: bool,
    pub reverted_count: usize,
    pub failed_count: usize,
    pub items: Vec<RollbackItemResult>,
}

impl ChangeSet {
    pub fn single(receipt: MutationReceipt) -> Self {
        Self {
            id: receipt.change_id.clone(),
            changes: vec![receipt],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalFileState {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub type ExternalFileSnapshot = BTreeMap<String, ExternalFileState>;

pub fn record_external_changes(
    checkpoint_root: &Path,
    root_id: &str,
    before: &ExternalFileSnapshot,
    after: &ExternalFileSnapshot,
) -> Result<ChangeSet, String> {
    let _guard = workspace_mutation_guard();
    let change_set_id = next_change_id();
    let mut changes = Vec::new();

    for (path, current) in after {
        match before.get(path) {
            None => changes.push(MutationReceipt {
                change_id: next_change_id(),
                root_id: root_id.to_string(),
                op: MutationKind::Created,
                relative_path: path.clone(),
                destination_path: None,
                before_hash: None,
                after_hash: Some(current.sha256.clone()),
                backup_ref: None,
                bytes: current.bytes.len() as u64,
            }),
            Some(previous) if previous.sha256 != current.sha256 => {
                let change_id = next_change_id();
                let backup_ref = create_checkpoint(checkpoint_root, &change_id, &previous.bytes)?;
                changes.push(MutationReceipt {
                    change_id,
                    root_id: root_id.to_string(),
                    op: MutationKind::Modified,
                    relative_path: path.clone(),
                    destination_path: None,
                    before_hash: Some(previous.sha256.clone()),
                    after_hash: Some(current.sha256.clone()),
                    backup_ref: Some(backup_ref),
                    bytes: current.bytes.len() as u64,
                });
            }
            _ => {}
        }
    }

    for (path, previous) in before {
        if after.contains_key(path) {
            continue;
        }
        let change_id = next_change_id();
        let backup_ref = create_checkpoint(checkpoint_root, &change_id, &previous.bytes)?;
        changes.push(MutationReceipt {
            change_id,
            root_id: root_id.to_string(),
            op: MutationKind::Deleted,
            relative_path: path.clone(),
            destination_path: None,
            before_hash: Some(previous.sha256.clone()),
            after_hash: None,
            backup_ref: Some(backup_ref),
            bytes: previous.bytes.len() as u64,
        });
    }

    changes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(ChangeSet {
        id: change_set_id,
        changes,
    })
}

pub fn rollback_change_set(
    root: &Path,
    checkpoint_root: &Path,
    change_set: &ChangeSet,
) -> RollbackChangeSetResult {
    let mut items = Vec::with_capacity(change_set.changes.len());
    for receipt in change_set.changes.iter().rev() {
        match rollback(root, checkpoint_root, receipt) {
            Ok(()) => items.push(RollbackItemResult {
                change_id: receipt.change_id.clone(),
                relative_path: receipt.relative_path.clone(),
                reverted: true,
                error: None,
            }),
            Err(error) => items.push(RollbackItemResult {
                change_id: receipt.change_id.clone(),
                relative_path: receipt.relative_path.clone(),
                reverted: false,
                error: Some(error),
            }),
        }
    }
    let reverted_count = items.iter().filter(|item| item.reverted).count();
    let failed_count = items.len().saturating_sub(reverted_count);
    RollbackChangeSetResult {
        change_set_id: change_set.id.clone(),
        complete: failed_count == 0,
        reverted_count,
        failed_count,
        items,
    }
}

pub fn workspace_mutation_guard() -> MutexGuard<'static, ()> {
    WORKSPACE_MUTATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn next_change_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sequence = CHANGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("change-{}-{}", millis, sequence)
}

fn display_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_mutation_path(raw: &str) -> Result<PathBuf, String> {
    let relative = normalize_runtime_relative_path(Some(raw))?;
    if relative.as_os_str().is_empty() {
        return Err("A relative workspace path is required".to_string());
    }
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Workspace mutation paths must contain normal components only".to_string());
        };
        let value = name
            .to_str()
            .ok_or_else(|| "Workspace mutation paths must be valid UTF-8".to_string())?
            .to_ascii_lowercase();
        if value.starts_with('.')
            || matches!(
                value.as_str(),
                "credentials" | "secrets" | "tokens" | "node_modules"
            )
        {
            return Err(format!(
                "Protected workspace path component is not writable: {}",
                value
            ));
        }
    }
    Ok(relative)
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {}", error))?;
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("Failed to inspect workspace root: {}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Workspace root must be a real directory".to_string());
    }
    Ok(canonical)
}

fn ensure_real_parent(root: &Path, relative: &Path, create: bool) -> Result<PathBuf, String> {
    let mut parent = root.to_path_buf();
    if let Some(relative_parent) = relative.parent() {
        for component in relative_parent.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            parent.push(name);
            if create {
                match fs::create_dir(&parent) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!("Failed to create workspace parent: {}", error))
                    }
                }
            }
            let metadata = fs::symlink_metadata(&parent)
                .map_err(|error| format!("Failed to inspect workspace parent: {}", error))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Workspace mutation paths cannot traverse symlinks".to_string());
            }
        }
    }
    let canonical = parent
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace parent: {}", error))?;
    if !canonical.starts_with(root) {
        return Err("Workspace mutation path escapes the selected root".to_string());
    }
    Ok(canonical)
}

fn target_path(root: &Path, relative: &Path, create_parent: bool) -> Result<PathBuf, String> {
    let parent = ensure_real_parent(root, relative, create_parent)?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| "Workspace target has no file name".to_string())?;
    Ok(parent.join(file_name))
}

fn open_regular_no_follow(path: &Path) -> Result<fs::File, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Workspace file does not exist: {}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Workspace mutations support regular files only".to_string());
    }
    if metadata.len() > MAX_MUTATION_BYTES {
        return Err("Workspace file exceeds the mutation size limit".to_string());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|error| format!("Failed to open workspace file safely: {}", error))
}

fn read_and_hash(path: &Path) -> Result<(Vec<u8>, String), String> {
    let mut file = open_regular_no_follow(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read workspace file: {}", error))?;
    if bytes.len() as u64 > MAX_MUTATION_BYTES {
        return Err("Workspace file grew beyond the mutation size limit".to_string());
    }
    let hash = hex::encode(Sha256::digest(&bytes));
    Ok((bytes, hash))
}

fn normalize_hash(expected: &str) -> Result<String, String> {
    let normalized = expected.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Expected current hash must be a SHA-256 hex digest".to_string());
    }
    Ok(normalized)
}

fn verify_current_hash(target: &Path, expected: &str) -> Result<String, String> {
    let expected = normalize_hash(expected)?;
    let (_, actual) = read_and_hash(target)?;
    if actual != expected {
        return Err(format!(
            "Workspace file changed concurrently (expected {}, found {})",
            expected, actual
        ));
    }
    Ok(actual)
}

fn atomic_write(target: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    if bytes.len() as u64 > MAX_MUTATION_BYTES {
        return Err("Workspace content exceeds the mutation size limit".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Workspace target has no parent".to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage workspace write: {}", error))?;
    staged
        .write_all(bytes)
        .map_err(|error| format!("Failed to stage workspace content: {}", error))?;
    staged
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("Failed to sync workspace content: {}", error))?;
    if overwrite {
        staged
            .persist(target)
            .map_err(|error| format!("Failed to replace workspace file: {}", error.error))?;
    } else {
        staged
            .persist_noclobber(target)
            .map_err(|error| format!("Failed to create workspace file: {}", error.error))?;
    }
    Ok(())
}

fn checkpoint_dir(checkpoint_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(checkpoint_root)
        .map_err(|error| format!("Failed to create checkpoint root: {}", error))?;
    let root = checkpoint_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve checkpoint root: {}", error))?;
    let directory = root.join(CHECKPOINT_DIR);
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Failed to create workspace checkpoint area: {}",
                error
            ))
        }
    }
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("Failed to inspect workspace checkpoint area: {}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Workspace checkpoint area must be a real directory".to_string());
    }
    directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace checkpoint area: {}", error))
}

fn create_checkpoint(
    checkpoint_root: &Path,
    change_id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let directory = checkpoint_dir(checkpoint_root)?;
    let name = format!("{}.backup", change_id);
    let target = directory.join(&name);
    atomic_write(&target, bytes, false)?;
    Ok(format!("{}/{}", CHECKPOINT_DIR, name))
}

fn read_checkpoint(checkpoint_root: &Path, backup_ref: &str) -> Result<Vec<u8>, String> {
    let relative = normalize_runtime_relative_path(Some(backup_ref))?;
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal(std::ffi::OsStr::new(CHECKPOINT_DIR))
    {
        return Err("Invalid workspace checkpoint reference".to_string());
    }
    let directory = checkpoint_dir(checkpoint_root)?;
    let target = directory.join(
        relative
            .file_name()
            .ok_or_else(|| "Invalid workspace checkpoint reference".to_string())?,
    );
    read_and_hash(&target).map(|(bytes, _)| bytes)
}

pub fn write_text(
    root: &Path,
    checkpoint_root: &Path,
    root_id: &str,
    raw_path: &str,
    content: &str,
    expected_current_hash: Option<&str>,
) -> Result<MutationReceipt, String> {
    write_bytes(
        root,
        checkpoint_root,
        root_id,
        raw_path,
        content.as_bytes(),
        expected_current_hash,
    )
}

pub fn write_bytes(
    root: &Path,
    checkpoint_root: &Path,
    root_id: &str,
    raw_path: &str,
    content: &[u8],
    expected_current_hash: Option<&str>,
) -> Result<MutationReceipt, String> {
    let _guard = workspace_mutation_guard();
    let root = canonical_root(root)?;
    let relative = normalize_mutation_path(raw_path)?;
    let target = target_path(&root, &relative, expected_current_hash.is_none())?;
    let change_id = next_change_id();
    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Workspace write target must be a regular file".to_string());
            }
            let expected = expected_current_hash.ok_or_else(|| {
                "expected_current_hash is required when overwriting an existing workspace file"
                    .to_string()
            })?;
            let (bytes, hash) = read_and_hash(&target)?;
            verify_current_hash(&target, expected)?;
            Some((bytes, hash))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_current_hash.is_some() {
                return Err("Expected-current-hash was supplied for a missing file".to_string());
            }
            None
        }
        Err(error) => return Err(format!("Failed to inspect workspace target: {}", error)),
    };
    let backup_ref = existing
        .as_ref()
        .map(|(bytes, _)| create_checkpoint(checkpoint_root, &change_id, bytes))
        .transpose()?;
    atomic_write(&target, content, existing.is_some())?;
    let after_hash = hex::encode(Sha256::digest(content));
    Ok(MutationReceipt {
        change_id,
        root_id: root_id.to_string(),
        op: if existing.is_some() {
            MutationKind::Modified
        } else {
            MutationKind::Created
        },
        relative_path: display_relative(&relative),
        destination_path: None,
        before_hash: existing.map(|(_, hash)| hash),
        after_hash: Some(after_hash),
        backup_ref,
        bytes: content.len() as u64,
    })
}

/// 判断 rename 失败是否因为跨卷/跨设备（此时需要降级为 copy + 删除源）。
fn is_cross_device_error(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    let cross = error.raw_os_error() == Some(libc::EXDEV);
    #[cfg(windows)]
    let cross = error.raw_os_error() == Some(17); // ERROR_NOT_SAME_DEVICE
    #[cfg(not(any(unix, windows)))]
    let cross = false;
    cross
}

/// 移动一个常规文件：优先原子 rename；跨卷 rename（EXDEV）时降级为
/// 「读源 → 原子写目标（noclobber）→ 删源」。降级路径中若删源失败，
/// 会回收目标副本，避免留下两份内容一致的文件。
fn move_regular_file(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device_error(&error) => {
            let (bytes, _) = read_and_hash(source)?;
            atomic_write(destination, &bytes, false)?;
            fs::remove_file(source).map_err(|remove_error| {
                let _ = fs::remove_file(destination);
                format!(
                    "Failed to remove move source after cross-volume copy: {}",
                    remove_error
                )
            })
        }
        Err(error) => Err(format!("Failed to move workspace file: {}", error)),
    }
}

/// 移动 workspace 文件。
///
/// ## 回滚元数据说明
/// Move 不产生 checkpoint 备份（`backup_ref` 恒为 None），因为内容本身未变；
/// 回滚所需的可恢复元数据完整记录在回执中：
/// - `relative_path` / `destination_path`：源与目标路径
/// - `before_hash` / `after_hash`：移动前后（相同的）内容 SHA-256
///
/// 回滚时会先校验目标文件哈希仍等于 `after_hash`，再 rename 回源路径；
/// 若目标在此期间被修改，回滚会拒绝执行（不会覆盖用户编辑）。
pub fn move_file(
    root: &Path,
    root_id: &str,
    raw_source: &str,
    raw_destination: &str,
    expected_current_hash: &str,
) -> Result<MutationReceipt, String> {
    let _guard = workspace_mutation_guard();
    let root = canonical_root(root)?;
    let source_relative = normalize_mutation_path(raw_source)?;
    let destination_relative = normalize_mutation_path(raw_destination)?;
    if source_relative == destination_relative {
        return Err("Move source and destination must differ".to_string());
    }
    let source = target_path(&root, &source_relative, false)?;
    let hash = verify_current_hash(&source, expected_current_hash)?;
    let destination = target_path(&root, &destination_relative, true)?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("Move destination already exists".to_string());
    }
    move_regular_file(&source, &destination)?;
    Ok(MutationReceipt {
        change_id: next_change_id(),
        root_id: root_id.to_string(),
        op: MutationKind::Moved,
        relative_path: display_relative(&source_relative),
        destination_path: Some(display_relative(&destination_relative)),
        before_hash: Some(hash.clone()),
        after_hash: Some(hash),
        backup_ref: None,
        bytes: fs::metadata(&destination)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    })
}

pub fn delete_file(
    root: &Path,
    checkpoint_root: &Path,
    root_id: &str,
    raw_path: &str,
    expected_current_hash: &str,
) -> Result<MutationReceipt, String> {
    let _guard = workspace_mutation_guard();
    let root = canonical_root(root)?;
    let relative = normalize_mutation_path(raw_path)?;
    let target = target_path(&root, &relative, false)?;
    verify_current_hash(&target, expected_current_hash)?;
    let (bytes, before_hash) = read_and_hash(&target)?;
    let change_id = next_change_id();
    let backup_ref = create_checkpoint(checkpoint_root, &change_id, &bytes)?;
    fs::remove_file(&target)
        .map_err(|error| format!("Failed to delete workspace file: {}", error))?;
    Ok(MutationReceipt {
        change_id,
        root_id: root_id.to_string(),
        op: MutationKind::Deleted,
        relative_path: display_relative(&relative),
        destination_path: None,
        before_hash: Some(before_hash),
        after_hash: None,
        backup_ref: Some(backup_ref),
        bytes: bytes.len() as u64,
    })
}

pub fn rollback(
    root: &Path,
    checkpoint_root: &Path,
    receipt: &MutationReceipt,
) -> Result<(), String> {
    let _guard = workspace_mutation_guard();
    let root = canonical_root(root)?;
    let relative = normalize_mutation_path(&receipt.relative_path)?;
    let target = target_path(&root, &relative, receipt.op == MutationKind::Deleted)?;
    match receipt.op {
        MutationKind::Created => {
            let expected = receipt
                .after_hash
                .as_deref()
                .ok_or_else(|| "Created receipt lacks after_hash".to_string())?;
            verify_current_hash(&target, expected)?;
            fs::remove_file(&target)
                .map_err(|error| format!("Failed to rollback created file: {}", error))
        }
        MutationKind::Modified => {
            let expected = receipt
                .after_hash
                .as_deref()
                .ok_or_else(|| "Modified receipt lacks after_hash".to_string())?;
            verify_current_hash(&target, expected)?;
            let backup = read_checkpoint(
                checkpoint_root,
                receipt
                    .backup_ref
                    .as_deref()
                    .ok_or_else(|| "Modified receipt lacks backup_ref".to_string())?,
            )?;
            atomic_write(&target, &backup, true)
        }
        MutationKind::Deleted => {
            if fs::symlink_metadata(&target).is_ok() {
                return Err(
                    "Workspace path was recreated after deletion; refusing stale rollback"
                        .to_string(),
                );
            }
            let backup = read_checkpoint(
                checkpoint_root,
                receipt
                    .backup_ref
                    .as_deref()
                    .ok_or_else(|| "Deleted receipt lacks backup_ref".to_string())?,
            )?;
            atomic_write(&target, &backup, false)
        }
        MutationKind::Moved => {
            if fs::symlink_metadata(&target).is_ok() {
                return Err("Move source was recreated; refusing stale rollback".to_string());
            }
            let destination_relative = normalize_mutation_path(
                receipt
                    .destination_path
                    .as_deref()
                    .ok_or_else(|| "Moved receipt lacks destination_path".to_string())?,
            )?;
            let destination = target_path(&root, &destination_relative, false)?;
            let expected = receipt
                .after_hash
                .as_deref()
                .ok_or_else(|| "Moved receipt lacks after_hash".to_string())?;
            verify_current_hash(&destination, expected)?;
            move_regular_file(&destination, &target)
                .map_err(|error| format!("Failed to rollback moved file: {}", error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(text: &str) -> String {
        hex::encode(Sha256::digest(text.as_bytes()))
    }

    fn external(text: &str) -> ExternalFileState {
        ExternalFileState {
            bytes: text.as_bytes().to_vec(),
            sha256: hash(text),
        }
    }

    #[test]
    fn create_modify_and_rollback_restore_exact_contents() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        let created = write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "src/new.txt",
            "one",
            None,
        )
        .unwrap();
        assert_eq!(created.op, MutationKind::Created);
        let modified = write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "src/new.txt",
            "two",
            Some(&hash("one")),
        )
        .unwrap();
        assert_eq!(modified.before_hash.as_deref(), Some(hash("one").as_str()));
        rollback(root.path(), checkpoints.path(), &modified).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("src/new.txt")).unwrap(),
            "one"
        );
        rollback(root.path(), checkpoints.path(), &created).unwrap();
        assert!(!root.path().join("src/new.txt").exists());
    }

    #[test]
    fn binary_write_is_hash_bound_and_rollback_restores_exact_bytes() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        let original = [0_u8, 1, 2, 0xff];
        let replacement = [9_u8, 8, 7, 0x80];
        let created = write_bytes(
            root.path(),
            checkpoints.path(),
            "workspace",
            "reports/output.docx",
            &original,
            None,
        )
        .unwrap();
        let original_hash = created.after_hash.clone().unwrap();
        let modified = write_bytes(
            root.path(),
            checkpoints.path(),
            "workspace",
            "reports/output.docx",
            &replacement,
            Some(&original_hash),
        )
        .unwrap();
        assert_eq!(modified.op, MutationKind::Modified);
        assert!(write_bytes(
            root.path(),
            checkpoints.path(),
            "workspace",
            "reports/output.docx",
            b"stale",
            Some(&original_hash),
        )
        .is_err());
        rollback(root.path(), checkpoints.path(), &modified).unwrap();
        assert_eq!(
            fs::read(root.path().join("reports/output.docx")).unwrap(),
            original
        );
    }

    #[test]
    fn move_delete_and_rollback_restore_tree() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/a.txt"), "alpha").unwrap();
        let moved = move_file(
            root.path(),
            "workspace",
            "docs/a.txt",
            "archive/a.txt",
            &hash("alpha"),
        )
        .unwrap();
        rollback(root.path(), checkpoints.path(), &moved).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("docs/a.txt")).unwrap(),
            "alpha"
        );
        let deleted = delete_file(
            root.path(),
            checkpoints.path(),
            "workspace",
            "docs/a.txt",
            &hash("alpha"),
        )
        .unwrap();
        rollback(root.path(), checkpoints.path(), &deleted).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("docs/a.txt")).unwrap(),
            "alpha"
        );
    }

    #[test]
    fn external_shell_change_set_rolls_back_created_modified_and_deleted_files() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "new").unwrap();
        fs::write(root.path().join("c.txt"), "created").unwrap();

        let before = ExternalFileSnapshot::from([
            ("a.txt".to_string(), external("old")),
            ("b.txt".to_string(), external("deleted")),
        ]);
        let after = ExternalFileSnapshot::from([
            ("a.txt".to_string(), external("new")),
            ("c.txt".to_string(), external("created")),
        ]);
        let change_set =
            record_external_changes(checkpoints.path(), "workspace", &before, &after).unwrap();
        assert_eq!(change_set.changes.len(), 3);

        let result = rollback_change_set(root.path(), checkpoints.path(), &change_set);
        assert!(result.complete);
        assert_eq!(result.reverted_count, 3);
        assert_eq!(result.failed_count, 0);
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "deleted"
        );
        assert!(!root.path().join("c.txt").exists());
    }

    #[test]
    fn change_set_rollback_reports_partial_failure_and_continues() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "agent-a").unwrap();
        fs::write(root.path().join("b.txt"), "agent-b").unwrap();
        fs::write(root.path().join("c.txt"), "created-c").unwrap();

        let before = ExternalFileSnapshot::from([
            ("a.txt".to_string(), external("before-a")),
            ("b.txt".to_string(), external("before-b")),
        ]);
        let after = ExternalFileSnapshot::from([
            ("a.txt".to_string(), external("agent-a")),
            ("b.txt".to_string(), external("agent-b")),
            ("c.txt".to_string(), external("created-c")),
        ]);
        let change_set =
            record_external_changes(checkpoints.path(), "workspace", &before, &after).unwrap();

        fs::write(root.path().join("b.txt"), "user-edit").unwrap();
        let result = rollback_change_set(root.path(), checkpoints.path(), &change_set);

        assert!(!result.complete);
        assert_eq!(result.reverted_count, 2);
        assert_eq!(result.failed_count, 1);
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "before-a"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "user-edit"
        );
        assert!(!root.path().join("c.txt").exists());
        assert!(result.items.iter().any(|item| {
            item.relative_path == "b.txt" && !item.reverted && item.error.is_some()
        }));
    }

    #[test]
    fn rejects_path_escape_protected_paths_and_stale_hashes() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        assert!(write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "../escape",
            "x",
            None
        )
        .is_err());
        assert!(write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            ".git/config",
            "x",
            None
        )
        .is_err());
        fs::write(root.path().join("note.txt"), "current").unwrap();
        assert!(write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "note.txt",
            "new",
            Some(&hash("old"))
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "current"
        );
    }

    #[test]
    fn stale_rollback_never_overwrites_user_edits() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        fs::write(root.path().join("note.txt"), "before").unwrap();
        let receipt = write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "note.txt",
            "agent",
            Some(&hash("before")),
        )
        .unwrap();
        fs::write(root.path().join("note.txt"), "user edit").unwrap();
        assert!(rollback(root.path(), checkpoints.path(), &receipt).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "user edit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_traversal() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let checkpoints = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(write_text(
            root.path(),
            checkpoints.path(),
            "workspace",
            "linked/escape.txt",
            "x",
            None
        )
        .is_err());
        assert!(!outside.path().join("escape.txt").exists());
    }
}
