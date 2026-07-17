use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;

const AUTHORIZED_ROOTS_KEY: &str = "chat_v2.runtime.authorized_roots";
const WORKSPACE_ROOT_KEY: &str = "chat_v2.runtime.workspace_root";
const SKILL_TRUST_KEY_PREFIX: &str = "chat_v2.skill_trust.";

/// Provenance ledger key prefix: `runtime_root.provenance.<root_id>`.
pub(crate) const RUNTIME_ROOT_PROVENANCE_PREFIX: &str = "runtime_root.provenance.";

/// Heuristic risk tier for authorized runtime roots (mirrors frontend `assessAuthorizedRootRisk`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizedRootRisk {
    Safe,
    Broad,
    Critical,
}

impl AuthorizedRootRisk {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthorizedRootRisk::Safe => "safe",
            AuthorizedRootRisk::Broad => "broad",
            AuthorizedRootRisk::Critical => "critical",
        }
    }
}

const BROAD_FOLDER_NAMES: &[&str] = &["desktop", "downloads", "documents", "桌面", "下载", "文档"];
const HOME_PARENT_NAMES: &[&str] = &["users", "home"];
const BROAD_MAX_DEPTH: usize = 3;

/// 会话 temp 根下的写备份区目录名（`workspace_artifact_write` 覆盖前的旧内容存这里）。
pub const WRITE_BACKUP_DIR: &str = ".write_backups";
const MAX_WRITE_BACKUP_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

/// 进程内单调序号：同毫秒多次备份也能拿到不同文件名。
static WRITE_BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Settings stores the authorized-root collection as one JSON value. Keep every
/// in-process read/modify/write sequence under one lock so concurrent grants and
/// revocations cannot overwrite each other with stale snapshots.
static RUNTIME_ROOT_SETTINGS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Artifact writes, deletes, and reverts use path-based filesystem APIs. This
/// lock closes races between those operations inside this process and makes the
/// expected-hash check meaningful for normal UI/tool concurrency.
static ARTIFACT_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SESSION_ROOT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRootKind {
    Workspace,
    Authorized,
    SkillPackage,
    Artifact,
    Temp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRootAccess {
    #[default]
    ReadOnly,
    ReadWrite,
}

impl RuntimeRootAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeRootAccess::ReadOnly => "read_only",
            RuntimeRootAccess::ReadWrite => "read_write",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeRoot {
    pub id: String,
    pub kind: RuntimeRootKind,
    pub path: PathBuf,
    pub access: RuntimeRootAccess,
    pub label: String,
    pub description: String,
    pub session_scoped: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeRootApprovalBinding {
    pub root_id: String,
    pub root_path: String,
    pub root_access: RuntimeRootAccess,
    pub root_session_scoped: bool,
    /// Digest of the selected root, cwd, session identity, and every effective
    /// sandbox-readable root. This is compared again immediately before exec.
    pub root_binding: String,
    pub readable_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillTrustRecord {
    skill_id: String,
    canonical_path: PathBuf,
    identity: RuntimeRootIdentity,
    package_sha256: String,
    trusted_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillTrustState {
    pub skill_id: String,
    pub trusted: bool,
    pub package_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthorizedRootRecord {
    id: String,
    path: PathBuf,
    label: String,
    #[serde(default)]
    identity: Option<RuntimeRootIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceRootRecord {
    path: PathBuf,
    label: String,
    #[serde(default)]
    access: RuntimeRootAccess,
    #[serde(default)]
    identity: Option<RuntimeRootIdentity>,
}

/// Stable identity of the directory object that was selected by the user.
/// Canonical paths alone do not detect deleting and recreating a directory at
/// the same pathname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RuntimeRootIdentity {
    Unix {
        device: u64,
        inode: u64,
    },
    Windows {
        volume_serial_number: u32,
        file_index: u64,
    },
    CanonicalPath {
        path: PathBuf,
    },
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileInformation {
    attributes: u32,
    volume_serial_number: u32,
    file_index: u64,
}

#[cfg(windows)]
fn windows_file_information(file: &fs::File) -> io::Result<WindowsFileInformation> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the file handle remains valid for the call, and Windows initializes
    // the entire output structure before returning a nonzero result.
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a nonzero result guarantees that the output structure was initialized.
    let information = unsafe { information.assume_init() };
    Ok(WindowsFileInformation {
        attributes: information.dwFileAttributes,
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

fn lock_or_recover<T>(lock: &'static Mutex<T>, name: &str) -> MutexGuard<'static, T> {
    lock.lock().unwrap_or_else(|poisoned| {
        log::error!("[RuntimeRoots] {} mutex poisoned; recovering", name);
        poisoned.into_inner()
    })
}

fn runtime_root_settings_guard() -> MutexGuard<'static, ()> {
    lock_or_recover(
        RUNTIME_ROOT_SETTINGS_LOCK.get_or_init(|| Mutex::new(())),
        "settings",
    )
}

pub(crate) fn artifact_mutation_guard() -> MutexGuard<'static, ()> {
    lock_or_recover(
        ARTIFACT_MUTATION_LOCK.get_or_init(|| Mutex::new(())),
        "artifact mutation",
    )
}

pub fn safe_session_dir(session_id: &str) -> String {
    const MAX_SANITIZED_PREFIX_LEN: usize = 96;

    let mut sanitized = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(MAX_SANITIZED_PREFIX_LEN)
        .collect::<String>();
    sanitized = sanitized.trim_matches(['-', '_']).to_string();
    if sanitized.is_empty() {
        sanitized = "session".to_string();
    }
    let digest = Sha256::digest(session_id.as_bytes());
    format!("v2-{}-{}", sanitized, &hex::encode(digest)[..32])
}

fn legacy_safe_session_dir(session_id: &str) -> String {
    session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn unambiguous_legacy_session_dir(session_id: &str) -> Option<String> {
    const MAX_LEGACY_COMPONENT_BYTES: usize = 200;
    if session_id.is_empty() || session_id.len() > MAX_LEGACY_COMPONENT_BYTES {
        return None;
    }
    let legacy = legacy_safe_session_dir(session_id);
    (legacy == session_id).then_some(legacy)
}

fn session_runtime_root_path(base: &Path, directory: &str, session_id: &str) -> PathBuf {
    base.join(directory).join(safe_session_dir(session_id))
}

fn legacy_session_runtime_root_path(
    base: &Path,
    directory: &str,
    session_id: &str,
) -> Option<PathBuf> {
    unambiguous_legacy_session_dir(session_id).map(|legacy| base.join(directory).join(legacy))
}

fn resolve_session_runtime_root(
    base: &Path,
    directory: &str,
    session_id: &str,
    create: bool,
) -> Result<PathBuf, String> {
    let _session_root_guard = lock_or_recover(
        SESSION_ROOT_LOCK.get_or_init(|| Mutex::new(())),
        "session root",
    );
    if create {
        fs::create_dir_all(base)
            .map_err(|error| format!("Failed to create app data dir: {}", error))?;
    }
    let base_canon = match base.canonicalize() {
        Ok(path) => path,
        Err(error) if !create && error.kind() == io::ErrorKind::NotFound => {
            return Ok(session_runtime_root_path(base, directory, session_id));
        }
        Err(error) => return Err(format!("Failed to resolve app data dir: {}", error)),
    };
    let container = base_canon.join(directory);
    if create {
        fs::create_dir_all(&container)
            .map_err(|error| format!("Failed to create runtime-root container: {}", error))?;
    }

    match fs::symlink_metadata(&container) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Runtime-root container must be a real directory".to_string());
            }
            let container_canon = container
                .canonicalize()
                .map_err(|error| format!("Failed to resolve runtime-root container: {}", error))?;
            if !container_canon.starts_with(&base_canon) {
                return Err("Runtime-root container escapes the app data directory".to_string());
            }

            let root = container_canon.join(safe_session_dir(session_id));
            if create {
                if !root.exists() {
                    if let Some(legacy_name) = unambiguous_legacy_session_dir(session_id) {
                        let legacy = container_canon.join(legacy_name);
                        match fs::symlink_metadata(&legacy) {
                            Ok(metadata) => {
                                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                                    return Err(
                                        "Legacy session runtime root must be a real directory"
                                            .to_string(),
                                    );
                                }
                                fs::rename(&legacy, &root).map_err(|error| {
                                    format!(
                                        "Failed to migrate legacy session runtime root: {}",
                                        error
                                    )
                                })?;
                            }
                            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                            Err(error) => {
                                return Err(format!(
                                    "Failed to inspect legacy session runtime root: {}",
                                    error
                                ))
                            }
                        }
                    }
                }
                if !root.exists() {
                    match fs::create_dir(&root) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => {
                            return Err(format!("Failed to create session runtime root: {}", error))
                        }
                    }
                }
            }
            match fs::symlink_metadata(&root) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err("Session runtime root must be a real directory".to_string());
                    }
                    let root_canon = root.canonicalize().map_err(|error| {
                        format!("Failed to resolve session runtime root: {}", error)
                    })?;
                    if !root_canon.starts_with(&container_canon) {
                        return Err("Session runtime root escapes its container".to_string());
                    }
                    Ok(root_canon)
                }
                Err(error) if !create && error.kind() == io::ErrorKind::NotFound => {
                    let Some(legacy_name) = unambiguous_legacy_session_dir(session_id) else {
                        return Ok(root);
                    };
                    let legacy = container_canon.join(legacy_name);
                    match fs::symlink_metadata(&legacy) {
                        Ok(metadata) => {
                            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                                return Err("Legacy session runtime root must be a real directory"
                                    .to_string());
                            }
                            legacy.canonicalize().map_err(|error| {
                                format!("Failed to resolve legacy session runtime root: {}", error)
                            })
                        }
                        Err(legacy_error) if legacy_error.kind() == io::ErrorKind::NotFound => {
                            Ok(root)
                        }
                        Err(legacy_error) => Err(format!(
                            "Failed to inspect legacy session runtime root: {}",
                            legacy_error
                        )),
                    }
                }
                Err(error) => Err(format!("Failed to inspect session runtime root: {}", error)),
            }
        }
        Err(error) if !create && error.kind() == io::ErrorKind::NotFound => Ok(
            session_runtime_root_path(&base_canon, directory, session_id),
        ),
        Err(error) => Err(format!(
            "Failed to inspect runtime-root container: {}",
            error
        )),
    }
}

fn remove_runtime_root_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect session runtime root '{}': {}",
                path.display(),
                error
            ))
        }
    };

    if metadata.file_type().is_symlink() {
        remove_symlink(path, &metadata)
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|error| {
        format!(
            "Failed to remove session runtime root '{}': {}",
            path.display(),
            error
        )
    })
}

#[cfg(not(windows))]
fn remove_symlink(path: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    fs::remove_file(path)
}

#[cfg(windows)]
fn remove_symlink(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;

    if metadata.file_type().is_symlink_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

fn cleanup_session_runtime_roots_in_base(base: &Path, session_id: &str) -> Result<(), String> {
    let _artifact_guard = artifact_mutation_guard();
    let _session_root_guard = lock_or_recover(
        SESSION_ROOT_LOCK.get_or_init(|| Mutex::new(())),
        "session root",
    );

    let mut failures = Vec::new();
    for directory in ["chat_v2_artifacts", "chat_v2_temp"] {
        let current = session_runtime_root_path(base, directory, session_id);
        if let Err(error) = remove_runtime_root_path(&current) {
            failures.push(error);
        }
        if let Some(legacy) = legacy_session_runtime_root_path(base, directory, session_id) {
            if let Err(error) = remove_runtime_root_path(&legacy) {
                failures.push(error);
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// Remove every per-session filesystem root, including artifact undo backups.
/// Call this before committing permanent session deletion so cleanup failures
/// leave a database record that can be retried.
pub fn cleanup_session_runtime_roots(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {}", error))?;
    cleanup_session_runtime_roots_in_base(&base, session_id)
}

pub fn normalize_runtime_relative_path(raw: Option<&str>) -> Result<PathBuf, String> {
    let raw = raw.unwrap_or("").trim();
    if raw.is_empty() || raw == "." {
        return Ok(PathBuf::new());
    }

    let path = Path::new(raw);
    if path.is_absolute() {
        return Err("Path must be relative to the selected runtime root".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Parent directory traversal is not allowed".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Path must be relative to the selected runtime root".to_string());
            }
        }
    }

    Ok(normalized)
}

fn canonicalize_existing_dir(raw_path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }

    let path = Path::new(trimmed);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {}", label, e))?;
    let meta =
        fs::metadata(&canonical).map_err(|e| format!("Failed to inspect {}: {}", label, e))?;
    if !meta.is_dir() {
        return Err(format!("{} must be an existing directory", label));
    }
    Ok(canonical)
}

fn runtime_root_identity(path: &Path) -> Result<RuntimeRootIdentity, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect runtime root identity: {}", error))?;
    if !metadata.is_dir() {
        return Err("Runtime root identity target is not a directory".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(RuntimeRootIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        });
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

        let directory = OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|error| format!("Failed to open runtime root identity: {}", error))?;
        let information = windows_file_information(&directory)
            .map_err(|error| format!("Failed to inspect runtime root identity: {}", error))?;
        return Ok(RuntimeRootIdentity::Windows {
            volume_serial_number: information.volume_serial_number,
            file_index: information.file_index,
        });
    }

    #[cfg(not(any(unix, windows)))]
    {
        Ok(RuntimeRootIdentity::CanonicalPath {
            path: path.to_path_buf(),
        })
    }
}

fn validate_persisted_root_binding(
    stored_path: &Path,
    stored_identity: Option<&RuntimeRootIdentity>,
    label: &str,
) -> Result<PathBuf, String> {
    let current = canonicalize_existing_dir(&stored_path.to_string_lossy(), label)?;
    if current != stored_path {
        return Err(format!(
            "{} was moved or rebound to a different target; select it again",
            label
        ));
    }
    let expected = stored_identity.ok_or_else(|| {
        format!(
            "{} predates runtime-root identity binding; select it again",
            label
        )
    })?;
    let current_identity = runtime_root_identity(&current)?;
    if &current_identity != expected {
        return Err(format!(
            "{} was replaced since it was authorized; select it again",
            label
        ));
    }
    Ok(current)
}

fn load_workspace_record(
    database: &crate::database::Database,
) -> Result<Option<WorkspaceRootRecord>, String> {
    let Some(raw) = database
        .get_setting(WORKSPACE_ROOT_KEY)
        .map_err(|e| format!("Failed to load workspace runtime root: {}", e))?
    else {
        return Ok(None);
    };
    serde_json::from_str(&raw).map(Some).map_err(|e| {
        format!(
            "Failed to parse workspace runtime root setting '{}': {}",
            WORKSPACE_ROOT_KEY, e
        )
    })
}

fn save_workspace_record(
    database: &crate::database::Database,
    record: &WorkspaceRootRecord,
) -> Result<(), String> {
    let raw = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize workspace runtime root: {}", e))?;
    database
        .save_setting(WORKSPACE_ROOT_KEY, &raw)
        .map_err(|e| format!("Failed to save workspace runtime root: {}", e))
}

fn workspace_runtime_root(record: WorkspaceRootRecord, configured: bool) -> RuntimeRoot {
    RuntimeRoot {
        id: "workspace".to_string(),
        kind: RuntimeRootKind::Workspace,
        path: record.path,
        access: record.access,
        label: record.label,
        description: if configured {
            match record.access {
                RuntimeRootAccess::ReadOnly => {
                    "User-selected workspace root. Read-only for agent runtime.".to_string()
                }
                RuntimeRootAccess::ReadWrite => {
                    "User-selected workspace root with explicit agent write access.".to_string()
                }
            }
        } else {
            "Workspace authorization is stale or the directory was replaced. Select it again."
                .to_string()
        },
        session_scoped: false,
        configured,
    }
}

fn configured_workspace_runtime_root(record: WorkspaceRootRecord) -> RuntimeRoot {
    workspace_runtime_root(record, true)
}

fn validate_workspace_access(canonical: &Path, access: RuntimeRootAccess) -> Result<(), String> {
    if access == RuntimeRootAccess::ReadWrite
        && assess_authorized_root_risk_canonical(canonical) == AuthorizedRootRisk::Critical
    {
        return Err(
            "Critical filesystem locations cannot be configured as a read-write agent workspace"
                .to_string(),
        );
    }
    Ok(())
}

pub fn workspace_root(database: &crate::database::Database) -> Result<RuntimeRoot, String> {
    if let Some(mut record) = load_workspace_record(database)? {
        if validate_workspace_access(&record.path, record.access).is_err() {
            log::error!(
                "[RuntimeRoots] Downgrading persisted critical workspace '{}' to read-only",
                record.path.display()
            );
            record.access = RuntimeRootAccess::ReadOnly;
        }
        let is_valid = validate_persisted_root_binding(
            &record.path,
            record.identity.as_ref(),
            "workspace runtime root",
        )
        .is_ok();
        return Ok(workspace_runtime_root(record, is_valid));
    }

    let path = std::env::current_dir()
        .map_err(|e| format!("Failed to resolve fallback workspace root: {}", e))?;
    Ok(RuntimeRoot {
        id: "workspace".to_string(),
        kind: RuntimeRootKind::Workspace,
        path,
        access: RuntimeRootAccess::ReadOnly,
        label: "Workspace".to_string(),
        description: "Fallback process workspace root. Read-only for agent runtime.".to_string(),
        session_scoped: false,
        configured: false,
    })
}

pub fn artifact_root(
    app: &AppHandle,
    session_id: &str,
    create: bool,
) -> Result<RuntimeRoot, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let path = resolve_session_runtime_root(&base, "chat_v2_artifacts", session_id, create)?;
    Ok(RuntimeRoot {
        id: "artifacts".to_string(),
        kind: RuntimeRootKind::Artifact,
        path,
        access: RuntimeRootAccess::ReadWrite,
        label: "Artifacts".to_string(),
        description: "Per-session artifact root. Agent writes are limited to relative paths here."
            .to_string(),
        session_scoped: true,
        configured: false,
    })
}

pub fn temp_root(app: &AppHandle, session_id: &str, create: bool) -> Result<RuntimeRoot, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let path = resolve_session_runtime_root(&base, "chat_v2_temp", session_id, create)?;
    Ok(RuntimeRoot {
        id: "temp".to_string(),
        kind: RuntimeRootKind::Temp,
        path,
        access: RuntimeRootAccess::ReadWrite,
        label: "Temp".to_string(),
        description: "Per-session temporary root for runtime intermediates.".to_string(),
        session_scoped: true,
        configured: false,
    })
}

/// Ensure the app-owned, session-scoped runtime roots exist before tools need
/// them. These roots are part of the session environment, not user-selected
/// filesystem authority, so creating them does not broaden the sandbox.
pub fn ensure_session_runtime_roots(app: &AppHandle, session_id: &str) -> Result<(), String> {
    artifact_root(app, session_id, true)?;
    temp_root(app, session_id, true)?;
    Ok(())
}

pub(crate) fn canonicalize_authorized_dir(raw_path: &str) -> Result<PathBuf, String> {
    canonicalize_existing_dir(raw_path, "authorized runtime root")
}

/// 去掉 Windows `canonicalize` 产生的 `\\?\` verbatim 前缀，得到可展示 / 可评估的路径串。
/// `\\?\UNC\server\share` 还原为 `\\server\share`。
pub fn strip_windows_verbatim_prefix(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text.to_string()
}

/// 🔒 05 号报告 P1-1：风险评估必须在 canonicalize 后的真实路径上进行。
/// 直接对原始字符串评估会被 `..`、`\\?\` 前缀、8.3 短名等 Windows 写法绕过。
pub fn assess_authorized_root_risk_canonical(canonical: &Path) -> AuthorizedRootRisk {
    assess_authorized_root_risk(&strip_windows_verbatim_prefix(canonical))
}

/// Path-string heuristic aligned with frontend `assessAuthorizedRootRisk`.
pub fn assess_authorized_root_risk(raw_path: &str) -> AuthorizedRootRisk {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return AuthorizedRootRisk::Safe;
    }

    let normalized = trimmed.replace('\\', "/");
    let has_drive = normalized
        .as_bytes()
        .first()
        .map(|b| b.is_ascii_alphabetic())
        .unwrap_or(false)
        && normalized.as_bytes().get(1) == Some(&b':');
    let is_rooted = has_drive || normalized.starts_with('/');
    let body = if has_drive {
        normalized.get(2..).unwrap_or("")
    } else {
        normalized.as_str()
    };

    let mut segments: Vec<&str> = body
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect();

    let starts_with_home_tilde = segments.first().is_some_and(|seg| *seg == "~");
    if starts_with_home_tilde {
        segments = segments.into_iter().skip(1).collect();
        if segments.is_empty() {
            return AuthorizedRootRisk::Critical;
        }
    }

    if segments.is_empty() {
        return if is_rooted {
            AuthorizedRootRisk::Critical
        } else {
            AuthorizedRootRisk::Safe
        };
    }

    let lower_segments: Vec<String> = segments
        .iter()
        .map(|seg| seg.to_ascii_lowercase())
        .collect();

    if !starts_with_home_tilde {
        if HOME_PARENT_NAMES.contains(&lower_segments[0].as_str()) && segments.len() <= 2 {
            return AuthorizedRootRisk::Critical;
        }
        if lower_segments[0] == "root" && segments.len() == 1 {
            return AuthorizedRootRisk::Critical;
        }
    }

    if let Some(last) = lower_segments.last() {
        if BROAD_FOLDER_NAMES.contains(&last.as_str()) && segments.len() <= BROAD_MAX_DEPTH {
            return AuthorizedRootRisk::Broad;
        }
    }

    AuthorizedRootRisk::Safe
}

fn canonicalize_workspace_dir(raw_path: &str) -> Result<PathBuf, String> {
    canonicalize_existing_dir(raw_path, "workspace runtime root")
}

pub(crate) fn authorized_root_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    format!("authorized_{}", &hex::encode(hasher.finalize())[..16])
}

fn derive_authorized_root_label(canonical: &Path, label: Option<&str>) -> String {
    label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            canonical
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| canonical.to_string_lossy().to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthorizeRuntimeRootOutcome {
    pub root_id: String,
    pub path: PathBuf,
    pub label: String,
    pub newly_granted: bool,
}

/// Persist a read-only authorized runtime root (shared by Tauri command and agent tool).
pub(crate) fn authorize_runtime_root_path(
    database: &crate::database::Database,
    path: &str,
    label: Option<&str>,
) -> Result<AuthorizeRuntimeRootOutcome, String> {
    let canonical = canonicalize_authorized_dir(path)?;
    let identity = runtime_root_identity(&canonical)?;
    let id = authorized_root_id(&canonical);
    let label = derive_authorized_root_label(&canonical, label);

    let _settings_guard = runtime_root_settings_guard();
    let mut records = load_authorized_records(database)?;
    if let Some(existing) = records
        .iter()
        .find(|record| record.path == canonical && record.identity.as_ref() == Some(&identity))
    {
        return Ok(AuthorizeRuntimeRootOutcome {
            root_id: existing.id.clone(),
            path: canonical,
            label: existing.label.clone(),
            newly_granted: false,
        });
    }

    records.retain(|record| record.id != id && record.path != canonical);
    records.push(AuthorizedRootRecord {
        id: id.clone(),
        path: canonical.clone(),
        label: label.clone(),
        identity: Some(identity),
    });
    records.sort_by(|a, b| a.label.cmp(&b.label).then(a.path.cmp(&b.path)));
    save_authorized_records(database, &records)?;

    Ok(AuthorizeRuntimeRootOutcome {
        root_id: id,
        path: canonical,
        label,
        newly_granted: true,
    })
}

fn load_authorized_records(
    database: &crate::database::Database,
) -> Result<Vec<AuthorizedRootRecord>, String> {
    let Some(raw) = database
        .get_setting(AUTHORIZED_ROOTS_KEY)
        .map_err(|e| format!("Failed to load authorized runtime roots: {}", e))?
    else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse authorized runtime roots: {}", e))
}

fn save_authorized_records(
    database: &crate::database::Database,
    records: &[AuthorizedRootRecord],
) -> Result<(), String> {
    let raw = serde_json::to_string(records)
        .map_err(|e| format!("Failed to serialize authorized runtime roots: {}", e))?;
    database
        .save_setting(AUTHORIZED_ROOTS_KEY, &raw)
        .map_err(|e| format!("Failed to save authorized runtime roots: {}", e))
}

fn authorized_runtime_root(record: AuthorizedRootRecord, configured: bool) -> RuntimeRoot {
    RuntimeRoot {
        id: record.id,
        kind: RuntimeRootKind::Authorized,
        path: record.path,
        access: RuntimeRootAccess::ReadOnly,
        label: record.label,
        description: if configured {
            "User-authorized local directory. Read-only for agent runtime.".to_string()
        } else {
            "Directory authorization is stale or the directory was replaced. Authorize it again."
                .to_string()
        },
        session_scoped: false,
        configured,
    }
}

fn validate_authorized_record(record: &AuthorizedRootRecord) -> Result<(), String> {
    let canonical = validate_persisted_root_binding(
        &record.path,
        record.identity.as_ref(),
        "authorized runtime root",
    )?;
    if authorized_root_id(&canonical) != record.id {
        return Err("Authorized runtime root identity does not match its stored id".to_string());
    }
    Ok(())
}

/// Re-check a persisted root immediately before filesystem use. This closes the
/// gap between root lookup and opening a target when the selected directory was
/// renamed, recreated, or replaced with a symlink.
pub(crate) fn revalidate_runtime_root(
    database: &crate::database::Database,
    root: &RuntimeRoot,
) -> Result<PathBuf, String> {
    match root.kind {
        RuntimeRootKind::Workspace => {
            let record = load_workspace_record(database)?
                .ok_or_else(|| "Workspace root is no longer configured".to_string())?;
            if record.path != root.path {
                return Err("Workspace root changed while resolving the request".to_string());
            }
            validate_persisted_root_binding(
                &record.path,
                record.identity.as_ref(),
                "workspace runtime root",
            )
        }
        RuntimeRootKind::Authorized => {
            let record = load_authorized_records(database)?
                .into_iter()
                .find(|record| record.id == root.id)
                .ok_or_else(|| "Authorized runtime root was revoked".to_string())?;
            if record.path != root.path {
                return Err(
                    "Authorized runtime root changed while resolving the request".to_string(),
                );
            }
            validate_authorized_record(&record)?;
            Ok(record.path)
        }
        _ => root
            .path
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize runtime root: {}", error)),
    }
}

/// Stable token for approval scopes. It binds remembered authorization to the
/// currently opened directory object, not merely to aliases such as
/// `workspace` or a reusable canonical pathname.
pub(crate) fn runtime_root_binding_token(
    database: &crate::database::Database,
    root: &RuntimeRoot,
    session_id: &str,
) -> Result<String, String> {
    let canonical = revalidate_runtime_root(database, root)?;
    let identity = runtime_root_identity(&canonical)?;
    let payload = serde_json::to_vec(&serde_json::json!({
        "root_id": root.id,
        "kind": root.kind,
        "canonical_path": canonical,
        "identity": identity,
        "access": root.access,
        "session_scoped": root.session_scoped,
        "session_id": root.session_scoped.then_some(session_id),
    }))
    .map_err(|error| format!("Failed to serialize runtime-root binding: {}", error))?;
    Ok(hex::encode(Sha256::digest(payload)))
}

fn shell_approval_binding_digest(
    selected_root_binding: &str,
    cwd_canonical: &Path,
    cwd_identity: &RuntimeRootIdentity,
    readable: &[(String, String)],
) -> Result<String, String> {
    let approval_payload = serde_json::to_vec(&serde_json::json!({
        "selected_root": selected_root_binding,
        "cwd_path": cwd_canonical,
        "cwd_identity": cwd_identity,
        "readable_roots": readable,
    }))
    .map_err(|error| format!("Failed to serialize shell approval binding: {error}"))?;
    Ok(hex::encode(Sha256::digest(approval_payload)))
}

/// Resolve the exact filesystem authority a shell approval would grant.
///
/// The local shell sandbox can read every configured runtime root, not only
/// the selected cwd root. Keep those paths in the user-visible scope and bind
/// their directory identities into one digest so an authorization/root switch
/// between prompt and execution fails closed.
pub(crate) fn shell_runtime_approval_binding(
    app: &AppHandle,
    database: &crate::database::Database,
    session_id: &str,
    skill_package_roots: Option<&HashMap<String, String>>,
    root_id: Option<&str>,
    cwd: Option<&str>,
    support_readable_roots: &[PathBuf],
) -> Result<RuntimeRootApprovalBinding, String> {
    let mut selected = runtime_root_by_id(
        app,
        database,
        session_id,
        skill_package_roots,
        root_id,
        true,
    )?;
    selected.path = revalidate_runtime_root(database, &selected)?;

    let cwd_relative = normalize_runtime_relative_path(cwd)?;
    let cwd_path = selected.path.join(cwd_relative);
    let cwd_canonical = cwd_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve shell cwd for approval: {error}"))?;
    if !cwd_canonical.starts_with(&selected.path) || !cwd_canonical.is_dir() {
        return Err("Shell cwd is not a directory inside the selected runtime root".to_string());
    }
    let cwd_identity = runtime_root_identity(&cwd_canonical)?;

    let mut roots = runtime_roots_for_session(app, database, session_id, true)?;
    roots.retain(|root| {
        root.configured || matches!(root.kind, RuntimeRootKind::Artifact | RuntimeRootKind::Temp)
    });
    if !roots.iter().any(|root| root.id == selected.id) {
        roots.push(selected.clone());
    }
    if let Some(skill_roots) = skill_package_roots {
        for (skill_id, path) in skill_roots {
            roots.push(skill_package_runtime_root(skill_id, path)?);
        }
    }

    let mut readable = Vec::<(String, String)>::new();
    for mut root in roots {
        root.path = revalidate_runtime_root(database, &root)?;
        let path = strip_windows_verbatim_prefix(&root.path);
        if readable.iter().any(|(existing, _)| existing == &path) {
            continue;
        }
        let token = runtime_root_binding_token(database, &root, session_id)?;
        readable.push((path, token));
    }
    for support_root in support_readable_roots {
        let canonical = support_root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve sandbox support root: {error}"))?;
        let path = strip_windows_verbatim_prefix(&canonical);
        if readable.iter().any(|(existing, _)| existing == &path) {
            continue;
        }
        let identity = runtime_root_identity(&canonical)?;
        let payload = serde_json::to_vec(&serde_json::json!({
            "kind": "sandbox_support",
            "canonical_path": canonical,
            "identity": identity,
            "access": RuntimeRootAccess::ReadOnly,
        }))
        .map_err(|error| format!("Failed to serialize sandbox support binding: {error}"))?;
        readable.push((path, hex::encode(Sha256::digest(payload))));
    }
    readable.sort_by(|left, right| left.0.cmp(&right.0));

    let selected_token = runtime_root_binding_token(database, &selected, session_id)?;
    let root_binding =
        shell_approval_binding_digest(&selected_token, &cwd_canonical, &cwd_identity, &readable)?;
    let readable_roots = readable.into_iter().map(|(path, _)| path).collect();

    Ok(RuntimeRootApprovalBinding {
        root_id: selected.id.clone(),
        root_path: strip_windows_verbatim_prefix(&selected.path),
        root_access: selected.access,
        root_session_scoped: selected.session_scoped,
        root_binding,
        readable_roots,
    })
}

pub fn skill_package_runtime_root(skill_id: &str, raw_path: &str) -> Result<RuntimeRoot, String> {
    let canonical = crate::chat_v2::skills::canonicalize_skill_package_root(raw_path)
        .map_err(|e| e.to_string())?;
    Ok(RuntimeRoot {
        id: format!("skill:{}", skill_id),
        kind: RuntimeRootKind::SkillPackage,
        path: canonical,
        access: RuntimeRootAccess::ReadOnly,
        label: format!("Skill: {}", skill_id),
        description: "Read-only skill package root for references, scripts, and assets."
            .to_string(),
        session_scoped: false,
        configured: false,
    })
}

fn skill_trust_key(skill_id: &str) -> String {
    format!("{}{}", SKILL_TRUST_KEY_PREFIX, skill_id)
}

fn current_skill_package_sha256(root: &Path) -> Result<String, String> {
    let files = crate::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::read_package_directory(root)?;
    Ok(
        crate::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::package_sha256(
            &files,
        ),
    )
}

fn validate_skill_trust(
    database: &crate::database::Database,
    skill_id: &str,
    root: &RuntimeRoot,
) -> Result<(), String> {
    let raw = database
        .get_setting(&skill_trust_key(skill_id))
        .map_err(|error| format!("Failed to read skill trust record: {error}"))?
        .ok_or_else(|| format!("Skill '{}' is not trusted by the backend", skill_id))?;
    let record: SkillTrustRecord = serde_json::from_str(&raw)
        .map_err(|error| format!("Skill trust record is invalid: {error}"))?;
    let canonical = root
        .path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve trusted skill package: {error}"))?;
    let identity = runtime_root_identity(&canonical)?;
    if record.skill_id != skill_id
        || record.canonical_path != canonical
        || record.identity != identity
    {
        return Err(format!(
            "Skill '{}' trust binding no longer matches the installed package",
            skill_id
        ));
    }
    let package_sha256 = current_skill_package_sha256(&canonical)?;
    if package_sha256 != record.package_sha256 {
        return Err(format!(
            "Skill '{}' changed after trust was granted; trust it again before using package files or scripts",
            skill_id
        ));
    }
    Ok(())
}

pub fn skill_package_root_by_id(
    database: &crate::database::Database,
    skill_package_roots: &HashMap<String, String>,
    root_id: &str,
) -> Result<Option<RuntimeRoot>, String> {
    let Some(skill_id) = root_id.strip_prefix("skill:") else {
        return Ok(None);
    };
    let Some(path) = skill_package_roots.get(skill_id) else {
        return Ok(None);
    };
    let root = skill_package_runtime_root(skill_id, path)?;
    validate_skill_trust(database, skill_id, &root)?;
    Ok(Some(root))
}

pub fn authorized_roots(database: &crate::database::Database) -> Result<Vec<RuntimeRoot>, String> {
    load_authorized_records(database).map(|records| {
        records
            .into_iter()
            .map(|record| {
                let configured = validate_authorized_record(&record).is_ok();
                authorized_runtime_root(record, configured)
            })
            .collect::<Vec<_>>()
    })
}

pub fn authorized_root_by_id(
    database: &crate::database::Database,
    root_id: &str,
) -> Result<Option<RuntimeRoot>, String> {
    let Some(record) = load_authorized_records(database)?
        .into_iter()
        .find(|record| record.id == root_id)
    else {
        return Ok(None);
    };
    validate_authorized_record(&record).map_err(|error| {
        format!(
            "Authorized runtime root '{}' is no longer valid: {}",
            root_id, error
        )
    })?;
    Ok(Some(authorized_runtime_root(record, true)))
}

pub fn runtime_root_by_id(
    app: &AppHandle,
    database: &crate::database::Database,
    session_id: &str,
    skill_package_roots: Option<&HashMap<String, String>>,
    root_id: Option<&str>,
    create_session_roots: bool,
) -> Result<RuntimeRoot, String> {
    match root_id.unwrap_or("workspace") {
        "workspace" => {
            let root = workspace_root(database)?;
            // 🔒 05 号报告 P1-2：用户未选择 workspace root 时，fallback 指向进程 CWD
            // （可能是安装目录甚至用户主目录）。未配置的 workspace 不参与文件/Shell 访问，
            // 仅在 roots 列表中以 configured=false 展示。
            if !root.configured {
                return Err(
                    "Workspace root is not configured. Ask the user to select a workspace \
                     directory in Settings > 工具权限, or use root_id=artifacts / temp instead."
                        .to_string(),
                );
            }
            Ok(root)
        }
        "artifact" | "artifacts" => artifact_root(app, session_id, create_session_roots),
        "temp" => temp_root(app, session_id, create_session_roots),
        other if other.starts_with("authorized_") => authorized_root_by_id(database, other)?
            .ok_or_else(|| {
                format!(
                    "Unsupported runtime root '{}'. It is not in the authorized roots list.",
                    other
                )
            }),
        other if other.starts_with("skill:") => {
            let roots = skill_package_roots.ok_or_else(|| {
                "No skill package roots are available in the current runtime context.".to_string()
            })?;
            skill_package_root_by_id(database, roots, other)?.ok_or_else(|| {
                format!(
                    "Unsupported runtime root '{}'. It is not available for the current loaded skills.",
                    other
                )
            })
        }
        other => Err(format!(
            "Unsupported runtime root '{}'. Allowed roots: workspace, authorized roots, skill:<skillId>, artifacts, temp",
            other
        )),
    }
}

/// Extract an explicit `root_id` / `rootId` from tool args (non-empty after trim).
pub fn explicit_runtime_root_id_from_args(args: &serde_json::Value) -> Option<String> {
    for key in ["root_id", "rootId"] {
        if let Some(raw) = args.get(key).and_then(|v| v.as_str()) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Session → group → `default_runtime_root_id` (no local resolvability check).
pub fn resolve_group_preferred_runtime_root_id(
    db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
) -> Option<String> {
    resolve_group_preferred_runtime_root(db, session_id).and_then(|pref| pref.root_id)
}

/// Preferred runtime root binding for a session's group (id + local path cache).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupPreferredRuntimeRoot {
    pub root_id: Option<String>,
    pub project_root_path: Option<String>,
}

/// Session → group → preferred runtime root fields (no local resolvability check).
pub fn resolve_group_preferred_runtime_root(
    db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
) -> Option<GroupPreferredRuntimeRoot> {
    use crate::chat_v2::repo::ChatV2Repo;

    let conn = match db.get_conn_safe() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!(
                "[runtime_roots] failed to open chat_v2 db while resolving preferred root for session '{}': {}",
                session_id,
                error
            );
            return None;
        }
    };

    let session = match ChatV2Repo::get_session_with_conn(&conn, session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return None,
        Err(error) => {
            log::warn!(
                "[runtime_roots] failed to load session '{}' for preferred root: {}",
                session_id,
                error
            );
            return None;
        }
    };

    let group_id = session
        .group_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())?;

    let group = match ChatV2Repo::get_group_with_conn(&conn, group_id) {
        Ok(Some(group)) => group,
        Ok(None) => return None,
        Err(error) => {
            log::warn!(
                "[runtime_roots] failed to load group '{}' for preferred root: {}",
                group_id,
                error
            );
            return None;
        }
    };

    let root_id = group
        .default_runtime_root_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let project_root_path = group
        .preferred_project_root_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);

    if root_id.is_none() && project_root_path.is_none() {
        return None;
    }

    Some(GroupPreferredRuntimeRoot {
        root_id,
        project_root_path,
    })
}

/// Pure merge: explicit > preferred > `"workspace"`.
///
/// Callers that need "preferred must be locally resolvable" should filter
/// preferred first (see [`resolve_effective_runtime_root_id_for_session`]).
pub fn effective_runtime_root_id(explicit: Option<&str>, preferred: Option<&str>) -> String {
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return id.to_string();
    }
    if let Some(id) = preferred.map(str::trim).filter(|s| !s.is_empty()) {
        return id.to_string();
    }
    "workspace".to_string()
}

/// Whether `root_id` can be resolved on this device for the given session.
pub fn is_runtime_root_id_resolvable(
    app: &AppHandle,
    database: &crate::database::Database,
    session_id: &str,
    skill_package_roots: Option<&HashMap<String, String>>,
    root_id: &str,
) -> bool {
    runtime_root_by_id(
        app,
        database,
        session_id,
        skill_package_roots,
        Some(root_id),
        false,
    )
    .is_ok()
}

/// Resolve the runtime root id tools should use when args omit an explicit root.
///
/// - Explicit `root_id` / `rootId` is never overridden.
/// - Otherwise uses the session group's `default_runtime_root_id` when locally resolvable.
/// - Unresolvable preferred roots degrade to `"workspace"` (does not abort the round).
pub fn resolve_effective_runtime_root_id_for_session(
    app: &AppHandle,
    main_db: &crate::database::Database,
    chat_v2_db: Option<&crate::chat_v2::database::ChatV2Database>,
    session_id: &str,
    skill_package_roots: Option<&HashMap<String, String>>,
    explicit: Option<&str>,
) -> String {
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return id.to_string();
    }

    let preferred = chat_v2_db.and_then(|db| resolve_group_preferred_runtime_root_id(db, session_id));
    if let Some(ref preferred_id) = preferred {
        if is_runtime_root_id_resolvable(
            app,
            main_db,
            session_id,
            skill_package_roots,
            preferred_id,
        ) {
            return preferred_id.clone();
        }
        log::warn!(
            "[runtime_roots] group preferred runtime root '{}' for session '{}' is not resolvable on this device; falling back to workspace",
            preferred_id,
            session_id
        );
    }

    effective_runtime_root_id(None, None)
}

/// Redact an absolute path for display (home → `~`).
pub fn redact_path_for_display(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(home) = dirs::home_dir() {
        let home_s = home.to_string_lossy();
        if !home_s.is_empty() {
            if trimmed == home_s.as_ref() {
                return "~".to_string();
            }
            let prefix = format!(
                "{}{}",
                home_s,
                std::path::MAIN_SEPARATOR
            );
            if let Some(rest) = trimmed.strip_prefix(&prefix) {
                return format!("~/{}", rest.replace('\\', "/"));
            }
            // Also accept forward-slash home prefixes on Windows-style mixed paths.
            if let Some(rest) = trimmed.strip_prefix(home_s.as_ref()) {
                if rest.starts_with('/') || rest.starts_with('\\') {
                    return format!("~{}", rest.replace('\\', "/"));
                }
            }
        }
    }
    trimmed.replace('\\', "/")
}

#[tauri::command]
pub async fn chat_v2_set_skill_trust(
    state: State<'_, AppState>,
    skill_id: String,
    package_root: Option<String>,
    trusted: bool,
) -> Result<SkillTrustState, String> {
    let skill_id = skill_id.trim();
    if skill_id.is_empty()
        || !skill_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Invalid skill id for trust record".to_string());
    }
    let key = skill_trust_key(skill_id);
    if !trusted {
        state
            .database
            .delete_setting(&key)
            .map_err(|error| format!("Failed to revoke skill trust: {error}"))?;
        return Ok(SkillTrustState {
            skill_id: skill_id.to_string(),
            trusted: false,
            package_sha256: None,
        });
    }

    let package_root = package_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("package_root is required when trusting a skill")?;
    let root = skill_package_runtime_root(skill_id, package_root)?;
    let canonical = root
        .path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve skill package: {error}"))?;
    let package_sha256 = current_skill_package_sha256(&canonical)?;
    let record = SkillTrustRecord {
        skill_id: skill_id.to_string(),
        canonical_path: canonical.clone(),
        identity: runtime_root_identity(&canonical)?,
        package_sha256: package_sha256.clone(),
        trusted_at: chrono::Utc::now().to_rfc3339(),
    };
    let encoded = serde_json::to_string(&record)
        .map_err(|error| format!("Failed to serialize skill trust record: {error}"))?;
    state
        .database
        .save_setting(&key, &encoded)
        .map_err(|error| format!("Failed to persist skill trust: {error}"))?;
    Ok(SkillTrustState {
        skill_id: skill_id.to_string(),
        trusted: true,
        package_sha256: Some(package_sha256),
    })
}

pub fn runtime_roots_for_session(
    app: &AppHandle,
    database: &crate::database::Database,
    session_id: &str,
    create_artifact_root: bool,
) -> Result<Vec<RuntimeRoot>, String> {
    let mut roots = vec![workspace_root(database)?];
    roots.extend(authorized_roots(database)?);
    roots.push(artifact_root(app, session_id, create_artifact_root)?);
    roots.push(temp_root(app, session_id, create_artifact_root)?);
    Ok(roots)
}

#[tauri::command]
pub async fn chat_v2_list_runtime_roots(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    let session_id = session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("session-preview");
    runtime_roots_for_session(&app, &state.database, session_id, false)
}

#[tauri::command]
pub async fn chat_v2_set_workspace_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
    access: Option<RuntimeRootAccess>,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    let canonical = canonicalize_workspace_dir(&path)?;
    let access = access.unwrap_or_default();
    validate_workspace_access(&canonical, access)?;
    let identity = runtime_root_identity(&canonical)?;
    let label = label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            canonical
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Workspace".to_string());

    {
        let _settings_guard = runtime_root_settings_guard();
        save_workspace_record(
            &state.database,
            &WorkspaceRootRecord {
                path: canonical,
                label,
                access,
                identity: Some(identity),
            },
        )?;
    }

    chat_v2_list_runtime_roots(app, state, session_id).await
}

#[tauri::command]
pub async fn chat_v2_reset_workspace_root(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    {
        let _settings_guard = runtime_root_settings_guard();
        state
            .database
            .delete_setting(WORKSPACE_ROOT_KEY)
            .map_err(|e| format!("Failed to reset workspace runtime root: {}", e))?;
    }

    chat_v2_list_runtime_roots(app, state, session_id).await
}

#[tauri::command]
pub async fn chat_v2_authorize_runtime_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    authorize_runtime_root_path(&state.database, &path, label.as_deref())?;

    chat_v2_list_runtime_roots(app, state, session_id).await
}

#[tauri::command]
pub async fn chat_v2_revoke_runtime_root(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: String,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    let _settings_guard = runtime_root_settings_guard();
    let mut records = load_authorized_records(&state.database)?;
    let before = records.len();
    records.retain(|record| record.id != root_id);
    if records.len() == before {
        return Err("Authorized runtime root not found".to_string());
    }
    save_authorized_records(&state.database, &records)?;
    drop(_settings_guard);

    chat_v2_list_runtime_roots(app, state, session_id).await
}

/// Resolve a `(root_id, relative_path)` pair to a canonical absolute path,
/// enforcing that the target stays inside the selected runtime root.
///
/// Used by the frontend to reveal artifacts/workspace files in the OS file
/// manager. Skill package roots are not resolvable here because they are only
/// available in the request-scoped send context.
fn resolve_runtime_target(
    app: &AppHandle,
    database: &crate::database::Database,
    session_id: &str,
    root_id: Option<&str>,
    relative_path: &str,
    create_session_roots: bool,
) -> Result<PathBuf, String> {
    let relative = normalize_runtime_relative_path(Some(relative_path))?;
    let root = runtime_root_by_id(
        app,
        database,
        session_id,
        None,
        root_id,
        create_session_roots,
    )?;
    if !root.path.exists() {
        return Err("runtime root does not exist".to_string());
    }
    let root_canon = revalidate_runtime_root(database, &root)?;
    let target = root_canon.join(&relative);
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Target path does not exist or cannot be resolved: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Path escapes the selected runtime root".to_string());
    }
    Ok(target_canon)
}

#[tauri::command]
pub async fn chat_v2_resolve_runtime_path(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    root_id: Option<String>,
    relative_path: String,
) -> Result<String, String> {
    let target = resolve_runtime_target(
        &app,
        &state.database,
        &session_id,
        root_id.as_deref(),
        &relative_path,
        false,
    )?;
    Ok(target.to_string_lossy().to_string())
}

/// Delete a single file inside the per-session artifacts root.
///
/// This is the minimal "undo this write" capability: it only targets the
/// session-scoped, read-write artifacts root, never workspace/authorized/skill
/// roots. Directories are refused so a stray relative path cannot wipe a tree.
#[tauri::command]
pub async fn chat_v2_delete_artifact(
    app: AppHandle,
    _state: State<'_, AppState>,
    session_id: String,
    relative_path: String,
) -> Result<serde_json::Value, String> {
    let _mutation_guard = artifact_mutation_guard();
    let relative = normalize_runtime_relative_path(Some(&relative_path))?;
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let root = artifact_root(&app, &session_id, false)?;
    if !root.path.exists() {
        return Err("No artifacts exist for this session yet".to_string());
    }
    remove_artifact_file(&root.path, &relative, None)?;
    Ok(serde_json::json!({
        "deleted": true,
        "root_id": root.id,
        "relative_path": relative.to_string_lossy().replace('\\', "/"),
    }))
}

/// 备份文件名里只保留安全字符（比 `safe_session_dir` 多放行 `.` 以保留扩展名）。
fn safe_backup_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(not(windows))]
fn metadata_matches_opened_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return before.dev() == opened.dev() && before.ino() == opened.ino();
    }

    #[cfg(not(any(unix, windows)))]
    {
        before.len() == opened.len()
            && before.modified().ok().is_some()
            && before.modified().ok() == opened.modified().ok()
    }
}

pub(crate) fn open_regular_file_no_follow(path: &Path, label: &str) -> Result<fs::File, String> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {}", label, error))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(format!("{} must be a regular file, not a symlink", label));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open {}: {}", label, error))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened {}: {}", label, error))?;
    if !opened.is_file() {
        return Err(format!("{} changed while it was being opened", label));
    }
    #[cfg(not(windows))]
    if !metadata_matches_opened_file(&before, &opened) {
        return Err(format!("{} changed while it was being opened", label));
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        };

        let information = windows_file_information(&file)
            .map_err(|error| format!("Failed to inspect opened {}: {}", label, error))?;
        if information.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(format!("{} must be a regular file, not a symlink", label));
        }
    }
    Ok(file)
}

fn ensure_write_backup_dir(temp_root_path: &Path) -> Result<PathBuf, String> {
    let temp_meta = fs::symlink_metadata(temp_root_path)
        .map_err(|error| format!("Failed to inspect temp root: {}", error))?;
    if temp_meta.file_type().is_symlink() || !temp_meta.is_dir() {
        return Err("Temp root must be a real directory".to_string());
    }
    let temp_canon = temp_root_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve temp root: {}", error))?;
    let backup_dir = temp_canon.join(WRITE_BACKUP_DIR);
    match fs::create_dir(&backup_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("Failed to create write backup dir: {}", error)),
    }
    let backup_meta = fs::symlink_metadata(&backup_dir)
        .map_err(|error| format!("Failed to inspect write backup dir: {}", error))?;
    if backup_meta.file_type().is_symlink() || !backup_meta.is_dir() {
        return Err("Write backup area must be a real directory".to_string());
    }
    let backup_canon = backup_dir
        .canonicalize()
        .map_err(|error| format!("Failed to resolve write backup dir: {}", error))?;
    if !backup_canon.starts_with(&temp_canon) {
        return Err("Write backup area escapes the temp root".to_string());
    }
    Ok(backup_canon)
}

/// 把即将被覆盖的旧产物内容写入 temp 根备份区，返回相对 temp 根的 backup_ref
/// （形如 `.write_backups/<毫秒时间戳>_<序号>_<原文件名>`，供撤销时恢复）。
pub fn create_write_backup(
    temp_root_path: &Path,
    original_file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let snapshot = create_write_backup_from_reader(
        temp_root_path,
        original_file_name,
        io::Cursor::new(bytes),
    )?;
    Ok(snapshot.backup_ref)
}

#[derive(Debug, Clone)]
pub(crate) struct WriteBackupSnapshot {
    pub backup_ref: String,
    pub sha256: String,
    pub bytes: u64,
}

fn create_write_backup_from_reader<R: Read>(
    temp_root_path: &Path,
    original_file_name: &str,
    mut reader: R,
) -> Result<WriteBackupSnapshot, String> {
    let backup_dir = ensure_write_backup_dir(temp_root_path)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = WRITE_BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
    let backup_name = format!(
        "{}_{:04}_{}",
        millis,
        seq,
        safe_backup_file_name(original_file_name)
    );
    let backup_path = backup_dir.join(&backup_name);
    let mut staged = tempfile::NamedTempFile::new_in(&backup_dir)
        .map_err(|e| format!("Failed to create staged backup: {}", e))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read backup source: {}", e))?;
        if read == 0 {
            break;
        }
        staged
            .write_all(&buffer[..read])
            .map_err(|e| format!("Failed to write staged backup: {}", e))?;
        hasher.update(&buffer[..read]);
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "Write backup size overflow".to_string())?;
        if total > MAX_WRITE_BACKUP_SOURCE_BYTES {
            return Err(format!(
                "Write backup source exceeds the {} MiB limit",
                MAX_WRITE_BACKUP_SOURCE_BYTES / (1024 * 1024)
            ));
        }
    }
    staged
        .as_file_mut()
        .sync_all()
        .map_err(|e| format!("Failed to sync staged backup: {}", e))?;
    staged
        .persist_noclobber(&backup_path)
        .map_err(|e| format!("Failed to persist backup: {}", e.error))?;

    Ok(WriteBackupSnapshot {
        backup_ref: format!("{}/{}", WRITE_BACKUP_DIR, backup_name),
        sha256: hex::encode(hasher.finalize()),
        bytes: total,
    })
}

pub(crate) fn create_write_backup_from_file(
    temp_root_path: &Path,
    original_file_name: &str,
    source: &Path,
) -> Result<WriteBackupSnapshot, String> {
    let file = open_regular_file_no_follow(source, "existing artifact for backup")?;
    let source_bytes = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened artifact for backup: {}", error))?
        .len();
    if source_bytes > MAX_WRITE_BACKUP_SOURCE_BYTES {
        return Err(format!(
            "Write backup source exceeds the {} MiB limit",
            MAX_WRITE_BACKUP_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    create_write_backup_from_reader(temp_root_path, original_file_name, file)
}

/// 校验 backup_ref 并解析为 temp 根备份区内的规范化绝对路径。
/// 只接受 `.write_backups/` 下的普通文件，拒绝绝对路径、`..` 与 symlink。
fn resolve_write_backup_source(temp_root_path: &Path, backup_ref: &str) -> Result<PathBuf, String> {
    let relative = normalize_runtime_relative_path(Some(backup_ref))?;
    let mut components = relative.components();
    match components.next() {
        Some(Component::Normal(part)) if part == std::ffi::OsStr::new(WRITE_BACKUP_DIR) => {}
        _ => return Err("backup_ref must point into the write backup area".to_string()),
    }
    let Some(Component::Normal(_file_name)) = components.next() else {
        return Err("backup_ref must point to a backup file".to_string());
    };
    if components.next().is_some() {
        return Err("backup_ref must identify one direct backup file".to_string());
    }
    let temp_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve temp root: {}", e))?;
    let source = temp_canon.join(&relative);
    let source_meta =
        fs::symlink_metadata(&source).map_err(|e| format!("Failed to inspect backup: {}", e))?;
    if source_meta.file_type().is_symlink() {
        return Err("Refusing to restore from a symlink backup".to_string());
    }
    if !source_meta.is_file() {
        return Err("backup_ref must be a file".to_string());
    }
    let parent_canon = source
        .parent()
        .ok_or_else(|| "Backup has no parent directory".to_string())?
        .canonicalize()
        .map_err(|e| format!("Failed to resolve backup parent: {}", e))?;
    if !parent_canon.starts_with(&temp_canon) {
        return Err("backup_ref escapes the temp root".to_string());
    }
    let source_canon = source
        .canonicalize()
        .map_err(|e| format!("Backup does not exist: {}", e))?;
    if !source_canon.starts_with(&temp_canon) {
        return Err("backup_ref escapes the temp root".to_string());
    }
    Ok(source_canon)
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = open_regular_file_no_follow(path, "artifact")?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read artifact: {}", e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read as u64);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn normalize_expected_sha256(expected: &str) -> Result<String, String> {
    let normalized = expected.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expected_after_hash must be a 64-character SHA-256 hex digest".to_string());
    }
    Ok(normalized)
}

fn artifact_target_with_parent(
    artifact_root_path: &Path,
    relative: &Path,
    create_parent: bool,
) -> Result<(PathBuf, PathBuf), String> {
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let root_canon = artifact_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve artifacts root: {}", e))?;
    let target = root_canon.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "Artifact target has no parent directory".to_string())?;
    if create_parent {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err("Path escapes the artifacts root".to_string());
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| "Artifact target has no file name".to_string())?;
    Ok((root_canon, parent_canon.join(file_name)))
}

fn verify_regular_artifact_hash(
    root_canon: &Path,
    target: &Path,
    expected_after_hash: &str,
) -> Result<(), String> {
    let expected = normalize_expected_sha256(expected_after_hash)?;
    let metadata = fs::symlink_metadata(target)
        .map_err(|e| format!("Artifact does not exist or cannot be inspected: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Artifact changed into a symlink; refusing stale undo".to_string());
    }
    if !metadata.is_file() {
        return Err("Artifact is no longer a regular file; refusing stale undo".to_string());
    }
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Artifact does not exist: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Path escapes the artifacts root".to_string());
    }
    let (actual, _) = sha256_file(&target_canon)?;
    if actual != expected {
        return Err(format!(
            "Artifact changed since this write (expected {}, found {}); refusing stale undo",
            expected, actual
        ));
    }
    Ok(())
}

fn atomic_copy_to_target<R: Read>(
    mut reader: R,
    target: &Path,
    overwrite: bool,
) -> Result<u64, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Artifact target has no parent directory".to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create staged artifact: {}", e))?;
    let bytes = io::copy(&mut reader, &mut staged)
        .map_err(|e| format!("Failed to stage artifact content: {}", e))?;
    staged
        .as_file_mut()
        .sync_all()
        .map_err(|e| format!("Failed to sync staged artifact: {}", e))?;
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Refusing to replace a symlink or non-file artifact".to_string());
            }
            if !overwrite {
                return Err("Artifact already exists".to_string());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to inspect artifact target: {}", error)),
    }
    if overwrite {
        staged
            .persist(target)
            .map_err(|e| format!("Failed to atomically replace artifact: {}", e.error))?;
    } else {
        staged
            .persist_noclobber(target)
            .map_err(|e| format!("Failed to atomically create artifact: {}", e.error))?;
    }
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(bytes)
}

/// Atomically restore old content from the backup. When an expected hash is
/// supplied, the current target must still be the exact output being undone.
fn restore_artifact_from_backup(
    artifact_root_path: &Path,
    temp_root_path: &Path,
    relative: &Path,
    backup_ref: &str,
    expected_after_hash: Option<&str>,
) -> Result<u64, String> {
    let source = resolve_write_backup_source(temp_root_path, backup_ref)?;
    let (root_canon, target) =
        artifact_target_with_parent(artifact_root_path, relative, expected_after_hash.is_none())?;
    if let Some(expected) = expected_after_hash {
        verify_regular_artifact_hash(&root_canon, &target, expected)?;
    } else if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || metadata.is_dir() {
            return Err("Refusing to restore over a symlink or directory".to_string());
        }
    }
    let source_file = open_regular_file_no_follow(&source, "backup for restore")?;
    atomic_copy_to_target(source_file, &target, true)
}

/// Delete an artifact file or the symlink itself. Never canonicalize a symlink
/// target before deletion, because that would delete the referent instead.
fn remove_artifact_file(
    artifact_root_path: &Path,
    relative: &Path,
    expected_after_hash: Option<&str>,
) -> Result<(), String> {
    let (root_canon, target) = artifact_target_with_parent(artifact_root_path, relative, false)?;
    let metadata =
        fs::symlink_metadata(&target).map_err(|e| format!("Artifact does not exist: {}", e))?;

    if let Some(expected) = expected_after_hash {
        verify_regular_artifact_hash(&root_canon, &target, expected)?;
    }

    if metadata.file_type().is_symlink() {
        if expected_after_hash.is_some() {
            return Err("Artifact changed into a symlink; refusing stale undo".to_string());
        }
        return remove_symlink(&target, &metadata)
            .map_err(|e| format!("Failed to delete artifact symlink: {}", e));
    }
    if !metadata.is_file() {
        return Err("Only artifact files can be deleted, not directories".to_string());
    }
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Artifact does not exist: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Path escapes the artifacts root".to_string());
    }
    fs::remove_file(&target).map_err(|e| format!("Failed to delete artifact: {}", e))
}

/// 真实撤销一次 `workspace_artifact_write`：
/// 有 backup_ref（当次为覆盖写）→ 从 temp 根备份区恢复旧内容；
/// 无 backup_ref（当次为新建）→ 删除该文件，等价于 `chat_v2_delete_artifact`。
#[tauri::command]
pub async fn chat_v2_revert_artifact_write(
    app: AppHandle,
    session_id: String,
    relative_path: String,
    backup_ref: Option<String>,
    expected_after_hash: String,
) -> Result<serde_json::Value, String> {
    let _mutation_guard = artifact_mutation_guard();
    let expected_after_hash = normalize_expected_sha256(&expected_after_hash)?;
    let relative = normalize_runtime_relative_path(Some(&relative_path))?;
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let root = artifact_root(&app, &session_id, false)?;
    if !root.path.exists() {
        return Err("No artifacts exist for this session yet".to_string());
    }
    let backup_ref = backup_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let relative_display = relative.to_string_lossy().replace('\\', "/");
    match backup_ref {
        Some(backup_ref) => {
            let temp = temp_root(&app, &session_id, false)?;
            let bytes_restored = restore_artifact_from_backup(
                &root.path,
                &temp.path,
                &relative,
                backup_ref,
                Some(&expected_after_hash),
            )?;
            Ok(serde_json::json!({
                "reverted": true,
                "mode": "restored",
                "root_id": root.id,
                "relative_path": relative_display,
                "bytes_restored": bytes_restored,
            }))
        }
        None => {
            remove_artifact_file(&root.path, &relative, Some(&expected_after_hash))?;
            Ok(serde_json::json!({
                "reverted": true,
                "mode": "deleted",
                "root_id": root.id,
                "relative_path": relative_display,
            }))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeFilePreview {
    pub content: String,
    pub truncated: bool,
}

/// 只读预览 session 可见 runtime root 内的文本文件。
/// 默认 64KB 上限，非 UTF-8 字节做 lossy 转换；路径校验复用 `resolve_runtime_target`。
#[tauri::command]
pub async fn chat_v2_read_runtime_file(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    root_id: String,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<RuntimeFilePreview, String> {
    let target = resolve_runtime_target(
        &app,
        &state.database,
        &session_id,
        Some(&root_id),
        &relative_path,
        false,
    )?;
    let max_bytes = max_bytes.unwrap_or(64 * 1024).clamp(1, 1024 * 1024) as usize;
    let file = open_regular_file_no_follow(&target, "runtime preview file")?;
    let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1));
    file.take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let truncated = bytes.len() > max_bytes;
    let visible = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    Ok(RuntimeFilePreview {
        content: String::from_utf8_lossy(visible).to_string(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_database(path: &Path) -> crate::database::Database {
        let database = crate::database::Database::new(path).expect("database");
        database
            .get_conn_safe()
            .expect("settings connection")
            .execute_batch(
                "CREATE TABLE settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .expect("settings schema");
        database
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_root_and_file_identities_use_handle_information() {
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let root = temp_dir.path().join("root");
        fs::create_dir(&root).expect("create root");
        let canonical = root.canonicalize().expect("canonical root");

        let first = runtime_root_identity(&canonical).expect("first root identity");
        let second = runtime_root_identity(&canonical).expect("second root identity");
        assert_eq!(first, second);

        let RuntimeRootIdentity::Windows {
            volume_serial_number,
            file_index: root_file_index,
        } = first
        else {
            panic!("expected Windows runtime root identity");
        };

        let file_path = canonical.join("sample.txt");
        fs::write(&file_path, "sample").expect("write sample");
        let file = open_regular_file_no_follow(&file_path, "sample file").expect("open sample");
        let information = windows_file_information(&file).expect("file information");

        assert_eq!(information.volume_serial_number, volume_serial_number);
        assert_ne!(information.file_index, root_file_index);
        assert_eq!(information.attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
    }

    #[test]
    fn backend_skill_trust_rejects_same_size_script_replacement() {
        let temp = tempfile::tempdir().expect("tempdir");
        let database = settings_database(&temp.path().join("trust.db"));
        let package = temp.path().join("external-tools");
        fs::create_dir_all(package.join("scripts")).expect("package dirs");
        fs::write(
            package.join("SKILL.md"),
            "---\nname: external-tools\n---\nBody",
        )
        .expect("skill body");
        fs::write(package.join("scripts/run.sh"), "echo safe\n").expect("safe script");
        let canonical = package.canonicalize().expect("canonical package");
        let package_sha256 = current_skill_package_sha256(&canonical).expect("package hash");
        let record = SkillTrustRecord {
            skill_id: "external-tools".to_string(),
            canonical_path: canonical.clone(),
            identity: runtime_root_identity(&canonical).expect("identity"),
            package_sha256,
            trusted_at: chrono::Utc::now().to_rfc3339(),
        };
        database
            .save_setting(
                &skill_trust_key("external-tools"),
                &serde_json::to_string(&record).expect("record json"),
            )
            .expect("save trust");
        let root = RuntimeRoot {
            id: "skill:external-tools".to_string(),
            kind: RuntimeRootKind::SkillPackage,
            path: canonical,
            access: RuntimeRootAccess::ReadOnly,
            label: "External tools".to_string(),
            description: String::new(),
            session_scoped: false,
            configured: false,
        };
        validate_skill_trust(&database, "external-tools", &root).expect("trusted package");

        fs::write(package.join("scripts/run.sh"), "echo evil\n").expect("replace script");
        assert_eq!(
            fs::metadata(package.join("scripts/run.sh")).unwrap().len(),
            10
        );
        assert!(validate_skill_trust(&database, "external-tools", &root).is_err());
    }

    #[test]
    fn sanitizes_session_dir() {
        let sanitized = safe_session_dir("sess:abc/123");
        assert!(sanitized.starts_with("v2-sess_abc_123-"));
        assert_eq!(sanitized.len(), "v2-sess_abc_123-".len() + 32);
        assert_ne!(sanitized, safe_session_dir("sess_abc_123"));
        assert_ne!(safe_session_dir(&sanitized), sanitized);
    }

    #[test]
    fn session_runtime_root_migrates_legacy_directory_once() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let container = temp_dir.path().join("chat_v2_artifacts");
        fs::create_dir_all(&container).expect("container");
        let session_id = "agent_01JUPPERCASE";
        let legacy =
            legacy_session_runtime_root_path(temp_dir.path(), "chat_v2_artifacts", session_id)
                .expect("unambiguous legacy id");
        fs::create_dir(&legacy).expect("legacy root");
        fs::write(legacy.join("result.md"), "kept").expect("legacy artifact");

        let migrated =
            resolve_session_runtime_root(temp_dir.path(), "chat_v2_artifacts", session_id, true)
                .expect("migrate");
        assert_eq!(
            migrated.file_name().unwrap(),
            std::ffi::OsStr::new(&safe_session_dir(session_id))
        );
        assert_eq!(
            fs::read_to_string(migrated.join("result.md")).unwrap(),
            "kept"
        );
        assert!(!legacy.exists());
    }

    #[cfg(unix)]
    #[test]
    fn session_runtime_root_rejects_symlink_rebinding() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let container = temp_dir.path().join("chat_v2_artifacts");
        let outside = temp_dir.path().join("outside");
        fs::create_dir_all(&container).expect("container");
        fs::create_dir_all(&outside).expect("outside");
        let session_id = "sess_rebound";
        symlink(&outside, container.join(safe_session_dir(session_id))).expect("symlink root");

        assert!(resolve_session_runtime_root(
            temp_dir.path(),
            "chat_v2_artifacts",
            session_id,
            true,
        )
        .is_err());
    }

    #[test]
    fn ambiguous_legacy_session_names_are_never_migrated_or_deleted() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let container = temp_dir.path().join("chat_v2_artifacts");
        fs::create_dir_all(&container).expect("container");
        let ambiguous_id = "sess_a/b";
        let colliding_legacy = container.join(legacy_safe_session_dir(ambiguous_id));
        fs::create_dir(&colliding_legacy).expect("legacy collision");
        fs::write(colliding_legacy.join("keep.md"), "keep").expect("legacy content");

        let root =
            resolve_session_runtime_root(temp_dir.path(), "chat_v2_artifacts", ambiguous_id, true)
                .expect("new isolated root");
        assert_ne!(root, colliding_legacy);
        assert!(colliding_legacy.join("keep.md").exists());

        cleanup_session_runtime_roots_in_base(temp_dir.path(), ambiguous_id).expect("cleanup new");
        assert!(colliding_legacy.join("keep.md").exists());
    }

    #[test]
    fn authorized_root_ids_are_stable() {
        let path = PathBuf::from("C:/Users/example/project");
        assert_eq!(authorized_root_id(&path), authorized_root_id(&path));
        assert!(authorized_root_id(&path).starts_with("authorized_"));
    }

    #[test]
    fn normalizes_runtime_relative_path() {
        assert_eq!(
            normalize_runtime_relative_path(Some("./notes/summary.md")).unwrap(),
            PathBuf::from("notes").join("summary.md")
        );
        assert_eq!(
            normalize_runtime_relative_path(Some("")).unwrap(),
            PathBuf::new()
        );
    }

    #[test]
    fn rejects_runtime_relative_path_escapes() {
        assert!(normalize_runtime_relative_path(Some("../secret.txt")).is_err());
        assert!(normalize_runtime_relative_path(Some("a/../../secret.txt")).is_err());
        assert!(normalize_runtime_relative_path(Some("/tmp/secret.txt")).is_err());
    }

    #[test]
    fn canonicalizes_authorized_directory_and_rejects_non_dirs() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let materials_dir = temp_dir.path().join("materials");
        fs::create_dir(&materials_dir).expect("create materials dir");

        let raw = format!(" {} ", materials_dir.display());
        let canonical = canonicalize_authorized_dir(&raw).expect("authorized dir");
        assert_eq!(canonical, materials_dir.canonicalize().unwrap());

        let file_path = materials_dir.join("note.txt");
        fs::write(&file_path, "hello").expect("write file");
        assert!(canonicalize_authorized_dir(file_path.to_string_lossy().as_ref()).is_err());
        assert!(canonicalize_authorized_dir("   ").is_err());
    }

    #[test]
    fn authorized_runtime_roots_are_read_only_and_global() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let path = temp_dir.path().canonicalize().expect("canonical");
        let id = authorized_root_id(&path);
        let root = authorized_runtime_root(
            AuthorizedRootRecord {
                id: id.clone(),
                path: path.clone(),
                label: "Materials".to_string(),
                identity: Some(runtime_root_identity(&path).expect("identity")),
            },
            true,
        );

        assert_eq!(root.id, id);
        assert_eq!(root.kind, RuntimeRootKind::Authorized);
        assert_eq!(root.access, RuntimeRootAccess::ReadOnly);
        assert_eq!(root.path, path);
        assert_eq!(root.label, "Materials");
        assert!(!root.session_scoped);
    }

    #[test]
    fn configured_workspace_roots_are_read_only_and_marked_configured() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let path = temp_dir.path().canonicalize().expect("canonical");
        let root = configured_workspace_runtime_root(WorkspaceRootRecord {
            path: path.clone(),
            label: "Study Workspace".to_string(),
            access: RuntimeRootAccess::ReadOnly,
            identity: Some(runtime_root_identity(&path).expect("identity")),
        });

        assert_eq!(root.id, "workspace");
        assert_eq!(root.kind, RuntimeRootKind::Workspace);
        assert_eq!(root.access, RuntimeRootAccess::ReadOnly);
        assert_eq!(root.path, path);
        assert_eq!(root.label, "Study Workspace");
        assert!(!root.session_scoped);
        assert!(root.configured);
    }

    #[test]
    fn configured_workspace_root_is_writable_only_when_explicitly_requested() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let path = temp_dir.path().canonicalize().expect("canonical");
        let root = configured_workspace_runtime_root(WorkspaceRootRecord {
            path: path.clone(),
            label: "Writable Workspace".to_string(),
            access: RuntimeRootAccess::ReadWrite,
            identity: Some(runtime_root_identity(&path).expect("identity")),
        });

        assert_eq!(root.access, RuntimeRootAccess::ReadWrite);
        assert!(root.description.contains("explicit agent write access"));
    }

    #[test]
    fn critical_workspace_locations_cannot_receive_write_access() {
        let home = dirs::home_dir()
            .expect("home directory")
            .canonicalize()
            .expect("canonical home");
        assert_eq!(
            assess_authorized_root_risk_canonical(&home),
            AuthorizedRootRisk::Critical
        );
        assert!(validate_workspace_access(&home, RuntimeRootAccess::ReadWrite).is_err());
        assert!(validate_workspace_access(&home, RuntimeRootAccess::ReadOnly).is_ok());
    }

    #[test]
    fn tampered_persisted_critical_workspace_is_downgraded_to_read_only() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let database = settings_database(&temp_dir.path().join("settings.db"));
        let home = dirs::home_dir()
            .expect("home directory")
            .canonicalize()
            .expect("canonical home");
        save_workspace_record(
            &database,
            &WorkspaceRootRecord {
                path: home.clone(),
                label: "Tampered Workspace".to_string(),
                access: RuntimeRootAccess::ReadWrite,
                identity: Some(runtime_root_identity(&home).expect("identity")),
            },
        )
        .expect("save tampered workspace");

        let root = workspace_root(&database).expect("load workspace");
        assert!(root.configured);
        assert_eq!(root.access, RuntimeRootAccess::ReadOnly);
    }

    #[test]
    fn legacy_workspace_record_deserializes_as_read_only() {
        let record: WorkspaceRootRecord = serde_json::from_value(serde_json::json!({
            "path": "/tmp/project",
            "label": "Legacy Workspace"
        }))
        .expect("legacy record");
        assert_eq!(record.access, RuntimeRootAccess::ReadOnly);
    }

    #[test]
    fn skill_package_runtime_roots_are_read_only_and_scoped_by_skill_id() {
        let package_dir = std::env::current_dir()
            .expect("current dir")
            .join(".skills")
            .join(format!("runtime-root-test-{}", std::process::id()));
        fs::create_dir_all(&package_dir).expect("create test skill package");
        fs::write(package_dir.join("SKILL.md"), "name: Runtime Root Test\n")
            .expect("write skill entry");

        let root = skill_package_runtime_root("runtime-root-test", &package_dir.to_string_lossy())
            .expect("skill package root");

        assert_eq!(root.id, "skill:runtime-root-test");
        assert_eq!(root.kind, RuntimeRootKind::SkillPackage);
        assert_eq!(root.access, RuntimeRootAccess::ReadOnly);
        assert_eq!(root.path, package_dir.canonicalize().unwrap());
        assert!(!root.session_scoped);

        let _ = fs::remove_dir_all(package_dir);
    }

    #[test]
    fn canonicalizes_workspace_directory_and_rejects_non_dirs() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir(&workspace_dir).expect("create workspace dir");

        let raw = format!(" {} ", workspace_dir.display());
        let canonical = canonicalize_workspace_dir(&raw).expect("workspace dir");
        assert_eq!(canonical, workspace_dir.canonicalize().unwrap());

        let file_path = workspace_dir.join("note.txt");
        fs::write(&file_path, "hello").expect("write file");
        assert!(canonicalize_workspace_dir(file_path.to_string_lossy().as_ref()).is_err());
        assert!(canonicalize_workspace_dir("   ").is_err());
    }

    #[test]
    fn persisted_root_binding_rejects_directory_replacement() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let selected = temp_dir.path().join("selected");
        let old = temp_dir.path().join("selected-old");
        fs::create_dir(&selected).expect("create selected");
        let canonical = selected.canonicalize().expect("canonical");
        let identity = runtime_root_identity(&canonical).expect("identity");
        assert!(
            validate_persisted_root_binding(&canonical, Some(&identity), "test runtime root")
                .is_ok()
        );

        fs::rename(&selected, &old).expect("rename old root");
        fs::create_dir(&selected).expect("replace selected root");
        assert!(
            validate_persisted_root_binding(&canonical, Some(&identity), "test runtime root")
                .is_err()
        );
    }

    #[test]
    fn stale_workspace_binding_is_listed_but_not_configured() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let database = settings_database(&temp_dir.path().join("settings.db"));
        let selected = temp_dir.path().join("workspace");
        let old = temp_dir.path().join("workspace-old");
        fs::create_dir(&selected).expect("create workspace");
        let canonical = selected.canonicalize().expect("canonical");
        save_workspace_record(
            &database,
            &WorkspaceRootRecord {
                path: canonical.clone(),
                label: "Workspace".to_string(),
                access: RuntimeRootAccess::ReadOnly,
                identity: Some(runtime_root_identity(&canonical).expect("identity")),
            },
        )
        .expect("save workspace");

        fs::rename(&selected, &old).expect("rename workspace");
        fs::create_dir(&selected).expect("replace workspace");
        let root = workspace_root(&database).expect("workspace root");
        assert!(!root.configured);
        assert_eq!(root.path, canonical);
    }

    #[test]
    fn concurrent_authorized_root_updates_do_not_lose_records() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let database = std::sync::Arc::new(settings_database(&temp_dir.path().join("settings.db")));
        let roots = (0..8)
            .map(|index| {
                let path = temp_dir.path().join(format!("root-{index}"));
                fs::create_dir(&path).expect("create root");
                path
            })
            .collect::<Vec<_>>();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(roots.len()));

        std::thread::scope(|scope| {
            for path in &roots {
                let database = std::sync::Arc::clone(&database);
                let barrier = std::sync::Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    authorize_runtime_root_path(&database, path.to_string_lossy().as_ref(), None)
                        .expect("authorize");
                });
            }
        });

        let records = load_authorized_records(&database).expect("records");
        assert_eq!(records.len(), roots.len());
        assert!(records.iter().all(|record| record.identity.is_some()));
    }

    #[test]
    fn approval_binding_token_changes_with_workspace_and_directory_identity() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let database = settings_database(&temp_dir.path().join("settings.db"));
        let first = temp_dir.path().join("first");
        let second = temp_dir.path().join("second");
        fs::create_dir(&first).expect("first");
        fs::create_dir(&second).expect("second");

        let save_workspace = |path: &Path| {
            let canonical = path.canonicalize().expect("canonical");
            save_workspace_record(
                &database,
                &WorkspaceRootRecord {
                    path: canonical.clone(),
                    label: "Workspace".to_string(),
                    access: RuntimeRootAccess::ReadOnly,
                    identity: Some(runtime_root_identity(&canonical).expect("identity")),
                },
            )
            .expect("save workspace");
        };

        save_workspace(&first);
        let first_root = workspace_root(&database).expect("first root");
        let first_token =
            runtime_root_binding_token(&database, &first_root, "sess-a").expect("first binding");
        save_workspace(&second);
        let second_root = workspace_root(&database).expect("second root");
        let second_token =
            runtime_root_binding_token(&database, &second_root, "sess-a").expect("second binding");
        assert_ne!(first_token, second_token);

        let mut write_enabled = second_root.clone();
        write_enabled.access = RuntimeRootAccess::ReadWrite;
        let write_enabled_token = runtime_root_binding_token(&database, &write_enabled, "sess-a")
            .expect("write-enabled binding");
        assert_ne!(
            second_token, write_enabled_token,
            "access is approval authority"
        );

        let session_root = RuntimeRoot {
            id: "temp".to_string(),
            kind: RuntimeRootKind::Temp,
            path: second.canonicalize().expect("session root path"),
            access: RuntimeRootAccess::ReadWrite,
            label: "Temp".to_string(),
            description: String::new(),
            session_scoped: true,
            configured: false,
        };
        assert_ne!(
            runtime_root_binding_token(&database, &session_root, "sess-a")
                .expect("session a binding"),
            runtime_root_binding_token(&database, &session_root, "sess-b")
                .expect("session b binding"),
            "session-scoped roots must not share approvals across sessions"
        );

        let authorized_path = temp_dir.path().join("authorized");
        let old_authorized = temp_dir.path().join("authorized-old");
        fs::create_dir(&authorized_path).expect("authorized");
        let first_outcome = authorize_runtime_root_path(
            &database,
            authorized_path.to_string_lossy().as_ref(),
            None,
        )
        .expect("authorize first");
        let first_authorized = authorized_root_by_id(&database, &first_outcome.root_id)
            .expect("lookup first")
            .expect("first root");
        let first_authorized_token =
            runtime_root_binding_token(&database, &first_authorized, "sess-a")
                .expect("first authorized binding");

        fs::rename(&authorized_path, &old_authorized).expect("move old authorized");
        fs::create_dir(&authorized_path).expect("replace authorized");
        let second_outcome = authorize_runtime_root_path(
            &database,
            authorized_path.to_string_lossy().as_ref(),
            None,
        )
        .expect("authorize replacement");
        let second_authorized = authorized_root_by_id(&database, &second_outcome.root_id)
            .expect("lookup replacement")
            .expect("replacement root");
        let second_authorized_token =
            runtime_root_binding_token(&database, &second_authorized, "sess-a")
                .expect("replacement binding");
        assert_ne!(first_authorized_token, second_authorized_token);
    }

    #[test]
    fn shell_binding_changes_when_support_readable_roots_change() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let cwd = temp_dir.path().canonicalize().expect("canonical cwd");
        let identity = runtime_root_identity(&cwd).expect("cwd identity");
        let first = vec![("/toolchain/a".to_string(), "identity-a".to_string())];
        let second = vec![("/toolchain/b".to_string(), "identity-b".to_string())];
        assert_ne!(
            shell_approval_binding_digest("selected", &cwd, &identity, &first).unwrap(),
            shell_approval_binding_digest("selected", &cwd, &identity, &second).unwrap(),
        );
    }

    #[test]
    fn write_backup_roundtrip_restores_original_content() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        let temp_root_path = temp_dir.path().join("temp");
        fs::create_dir_all(&artifacts).expect("create artifacts root");
        fs::create_dir_all(&temp_root_path).expect("create temp root");

        let relative = PathBuf::from("reports").join("summary.md");
        let target = artifacts.join(&relative);
        fs::create_dir_all(target.parent().unwrap()).expect("create parent");
        fs::write(&target, "v2 content").expect("write new content");

        let backup_ref =
            create_write_backup(&temp_root_path, "summary.md", b"v1 content").expect("backup");
        assert!(backup_ref.starts_with(".write_backups/"));
        assert!(backup_ref.ends_with("summary.md"));

        let expected_after_hash = hex::encode(Sha256::digest(b"v2 content"));
        let restored = restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            &backup_ref,
            Some(&expected_after_hash),
        )
        .expect("restore");
        assert_eq!(restored, "v1 content".len() as u64);
        assert_eq!(fs::read_to_string(&target).unwrap(), "v1 content");
    }

    #[test]
    fn write_backup_refs_are_unique_for_same_file_name() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let first = create_write_backup(temp_dir.path(), "notes.md", b"a").expect("backup 1");
        let second = create_write_backup(temp_dir.path(), "notes.md", b"b").expect("backup 2");
        assert_ne!(first, second);
        assert_eq!(fs::read(temp_dir.path().join(&first)).unwrap(), b"a");
        assert_eq!(fs::read(temp_dir.path().join(&second)).unwrap(), b"b");
    }

    #[test]
    fn write_backup_rejects_oversized_sources_before_streaming() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let temp_root_path = temp_dir.path().join("temp");
        fs::create_dir(&temp_root_path).expect("temp root");
        let source = temp_dir.path().join("oversized.bin");
        fs::File::create(&source)
            .expect("source")
            .set_len(MAX_WRITE_BACKUP_SOURCE_BYTES + 1)
            .expect("sparse length");

        assert!(create_write_backup_from_file(&temp_root_path, "oversized.bin", &source).is_err());
        assert!(!temp_root_path.join(WRITE_BACKUP_DIR).exists());
    }

    #[test]
    fn restore_rejects_backup_refs_outside_backup_area() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        let temp_root_path = temp_dir.path().join("temp");
        fs::create_dir_all(&artifacts).expect("create artifacts root");
        fs::create_dir_all(temp_root_path.join(WRITE_BACKUP_DIR)).expect("create backup area");
        fs::write(temp_root_path.join("loose.txt"), "loose").expect("write loose file");
        fs::write(temp_dir.path().join("outside.txt"), "outside").expect("write outside file");

        let relative = PathBuf::from("summary.md");
        // 绝对路径 / 上跳 / 备份区之外 / 指向备份目录本身 / 不存在的备份，全部拒绝
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            temp_dir
                .path()
                .join("outside.txt")
                .to_string_lossy()
                .as_ref(),
            None,
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            "../outside.txt",
            None,
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups/../loose.txt",
            None,
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            "loose.txt",
            None,
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups",
            None,
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups/missing.txt",
            None,
        )
        .is_err());
    }

    #[test]
    fn persisted_root_identity_deserializes_across_operating_systems() {
        let unix: RuntimeRootIdentity =
            serde_json::from_str(r#"{"kind":"unix","device":1,"inode":2}"#).expect("unix identity");
        let windows: RuntimeRootIdentity =
            serde_json::from_str(r#"{"kind":"windows","volume_serial_number":3,"file_index":4}"#)
                .expect("windows identity");
        let fallback: RuntimeRootIdentity =
            serde_json::from_str(r#"{"kind":"canonical_path","path":"/portable/workspace"}"#)
                .expect("fallback identity");

        assert_eq!(
            unix,
            RuntimeRootIdentity::Unix {
                device: 1,
                inode: 2
            }
        );
        assert_eq!(
            windows,
            RuntimeRootIdentity::Windows {
                volume_serial_number: 3,
                file_index: 4,
            }
        );
        assert!(matches!(
            fallback,
            RuntimeRootIdentity::CanonicalPath { .. }
        ));
    }

    #[test]
    fn remove_artifact_file_only_deletes_regular_files_inside_root() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        fs::create_dir_all(artifacts.join("reports")).expect("create nested dir");
        let target = artifacts.join("reports").join("summary.md");
        fs::write(&target, "content").expect("write target");

        assert!(remove_artifact_file(&artifacts, Path::new("reports"), None).is_err());
        assert!(remove_artifact_file(&artifacts, Path::new("missing.md"), None).is_err());
        assert!(remove_artifact_file(&artifacts, Path::new(""), None).is_err());
        let expected_after_hash = hex::encode(Sha256::digest(b"content"));
        remove_artifact_file(
            &artifacts,
            &PathBuf::from("reports").join("summary.md"),
            Some(&expected_after_hash),
        )
        .expect("delete file");
        assert!(!target.exists());
    }

    #[test]
    fn stale_undo_rejects_restore_and_delete() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        let temp_root_path = temp_dir.path().join("temp");
        fs::create_dir_all(&artifacts).expect("artifacts");
        fs::create_dir_all(&temp_root_path).expect("temp");
        let relative = PathBuf::from("report.md");
        let target = artifacts.join(&relative);
        fs::write(&target, "after-write").expect("after write");
        let expected_after_hash = hex::encode(Sha256::digest(b"after-write"));
        let backup_ref =
            create_write_backup(&temp_root_path, "report.md", b"before-write").expect("backup");

        fs::write(&target, "newer-user-edit").expect("newer edit");
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            &backup_ref,
            Some(&expected_after_hash),
        )
        .is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "newer-user-edit");

        assert!(remove_artifact_file(&artifacts, &relative, Some(&expected_after_hash)).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "newer-user-edit");
    }

    #[cfg(unix)]
    #[test]
    fn deleting_symlink_artifact_removes_link_not_referent() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        fs::create_dir_all(&artifacts).expect("artifacts");
        let outside = temp_dir.path().join("outside.txt");
        fs::write(&outside, "keep me").expect("outside");
        let link = artifacts.join("link.txt");
        symlink(&outside, &link).expect("symlink");

        remove_artifact_file(&artifacts, Path::new("link.txt"), None).expect("delete symlink");
        assert!(!link.exists());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep me");
    }

    #[test]
    fn session_runtime_cleanup_removes_artifacts_temp_and_backups() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let session_id = "sess_cleanup-test";
        let artifacts = session_runtime_root_path(temp_dir.path(), "chat_v2_artifacts", session_id);
        let temp = session_runtime_root_path(temp_dir.path(), "chat_v2_temp", session_id);
        fs::create_dir_all(&artifacts).expect("artifacts");
        fs::create_dir_all(temp.join(WRITE_BACKUP_DIR)).expect("backups");
        fs::write(artifacts.join("result.md"), "result").expect("artifact");
        fs::write(temp.join(WRITE_BACKUP_DIR).join("backup.md"), "backup").expect("backup");
        let legacy_artifacts =
            legacy_session_runtime_root_path(temp_dir.path(), "chat_v2_artifacts", session_id)
                .expect("unambiguous legacy id");
        fs::create_dir_all(&legacy_artifacts).expect("legacy artifacts");
        fs::write(legacy_artifacts.join("old.md"), "old").expect("legacy artifact");
        let unrelated = temp_dir.path().join("unrelated.txt");
        fs::write(&unrelated, "keep").expect("unrelated");

        cleanup_session_runtime_roots_in_base(temp_dir.path(), session_id).expect("cleanup");
        assert!(!artifacts.exists());
        assert!(!temp.exists());
        assert!(!legacy_artifacts.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn backup_file_names_are_sanitized() {
        assert_eq!(safe_backup_file_name("summary.md"), "summary.md");
        assert_eq!(safe_backup_file_name("a b/c.md"), "a_b_c.md");
        assert_eq!(safe_backup_file_name("..."), "artifact");
        assert_eq!(safe_backup_file_name("..secret"), "secret");
    }

    #[test]
    fn assesses_windows_authorized_root_risk() {
        assert_eq!(
            assess_authorized_root_risk(r"C:\"),
            AuthorizedRootRisk::Critical
        );
        assert_eq!(
            assess_authorized_root_risk(r"C:\Users"),
            AuthorizedRootRisk::Critical
        );
        assert_eq!(
            assess_authorized_root_risk(r"C:\Users\foo"),
            AuthorizedRootRisk::Critical
        );
        assert_eq!(
            assess_authorized_root_risk(r"C:\Users\foo\Desktop"),
            AuthorizedRootRisk::Broad
        );
        assert_eq!(
            assess_authorized_root_risk(r"C:\Users\foo\Documents\project\data"),
            AuthorizedRootRisk::Safe
        );
        assert_eq!(
            assess_authorized_root_risk("~/Downloads"),
            AuthorizedRootRisk::Broad
        );
        assert_eq!(
            assess_authorized_root_risk("~"),
            AuthorizedRootRisk::Critical
        );
    }

    /// SECURITY 回归（05 号报告 P1-1）：canonical 路径上的风险评估必须能剥掉
    /// `\\?\` verbatim 前缀，否则首段是 `?` 会被判为 Safe。
    #[test]
    fn assesses_risk_on_canonical_paths_with_verbatim_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\C:\Users\foo")),
            r"C:\Users\foo"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"C:\plain\path")),
            r"C:\plain\path"
        );

        // `\\?\C:\Users\foo`（canonicalize 输出形态）必须判 Critical
        assert_eq!(
            assess_authorized_root_risk_canonical(Path::new(r"\\?\C:\Users\foo")),
            AuthorizedRootRisk::Critical
        );
        assert_eq!(
            assess_authorized_root_risk_canonical(Path::new(r"\\?\C:\Users\foo\Desktop")),
            AuthorizedRootRisk::Broad
        );
        assert_eq!(
            assess_authorized_root_risk_canonical(Path::new(
                r"\\?\C:\Users\foo\Documents\project\data"
            )),
            AuthorizedRootRisk::Safe
        );
    }

    /// SECURITY 回归（05 号报告 P1-1）：`..` 上跳写法在 canonicalize 后必须落到
    /// 真实父目录再评估（原始字符串评估会把 `C:\Users\foo\Desktop\..` 判 Safe）。
    #[test]
    fn canonicalize_resolves_parent_traversal_before_risk_assessment() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let child = temp_dir.path().join("child");
        fs::create_dir(&child).expect("create child dir");

        let dotdot = format!("{}{}..", child.display(), std::path::MAIN_SEPARATOR);
        let canonical = canonicalize_authorized_dir(&dotdot).expect("canonicalize dotdot");
        assert_eq!(canonical, temp_dir.path().canonicalize().unwrap());
        // canonical 路径不应再含 `..` 组件
        assert!(!canonical
            .components()
            .any(|c| matches!(c, Component::ParentDir)));
    }

    #[test]
    fn authorize_runtime_root_path_is_idempotent() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let db_path = temp_dir.path().join("test.db");
        let database = settings_database(&db_path);
        let materials = temp_dir.path().join("materials");
        fs::create_dir(&materials).expect("create materials dir");

        let first = authorize_runtime_root_path(
            &database,
            materials.to_string_lossy().as_ref(),
            Some("Materials"),
        )
        .expect("first authorize");
        assert!(first.newly_granted);

        let second = authorize_runtime_root_path(
            &database,
            materials.to_string_lossy().as_ref(),
            Some("Materials"),
        )
        .expect("second authorize");
        assert!(!second.newly_granted);
        assert_eq!(second.root_id, first.root_id);
        assert_eq!(second.path, first.path);
    }

    #[test]
    fn runtime_root_kinds_serialize_for_frontend_contract() {
        assert_eq!(
            serde_json::to_string(&RuntimeRootKind::Workspace).unwrap(),
            "\"workspace\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeRootKind::Authorized).unwrap(),
            "\"authorized\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeRootKind::SkillPackage).unwrap(),
            "\"skill_package\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeRootKind::Artifact).unwrap(),
            "\"artifact\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeRootKind::Temp).unwrap(),
            "\"temp\""
        );
    }

    #[test]
    fn effective_runtime_root_id_prefers_explicit_then_preferred_then_workspace() {
        assert_eq!(
            effective_runtime_root_id(Some("temp"), Some("authorized_x")),
            "temp"
        );
        assert_eq!(
            effective_runtime_root_id(Some("  "), Some("authorized_x")),
            "authorized_x"
        );
        assert_eq!(
            effective_runtime_root_id(None, Some("authorized_x")),
            "authorized_x"
        );
        assert_eq!(effective_runtime_root_id(None, None), "workspace");
        assert_eq!(effective_runtime_root_id(Some(""), Some("")), "workspace");
    }

    #[test]
    fn explicit_runtime_root_id_from_args_reads_snake_and_camel() {
        assert_eq!(
            explicit_runtime_root_id_from_args(&serde_json::json!({"root_id": "temp"})).as_deref(),
            Some("temp")
        );
        assert_eq!(
            explicit_runtime_root_id_from_args(&serde_json::json!({"rootId": "artifacts"}))
                .as_deref(),
            Some("artifacts")
        );
        assert_eq!(
            explicit_runtime_root_id_from_args(&serde_json::json!({"root_id": "  "})),
            None
        );
        assert_eq!(
            explicit_runtime_root_id_from_args(&serde_json::json!({"cwd": "."})),
            None
        );
    }

    #[test]
    fn redact_path_for_display_masks_home_prefix() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let nested = home.join("Projects").join("demo");
        let redacted = redact_path_for_display(&nested.to_string_lossy());
        assert!(
            redacted.starts_with("~/Projects/demo") || redacted == "~/Projects/demo",
            "unexpected redaction: {redacted}"
        );
        assert_eq!(redact_path_for_display(&home.to_string_lossy()), "~");
        assert_eq!(redact_path_for_display("  "), "");
    }
}
