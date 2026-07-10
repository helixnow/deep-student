use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;

const AUTHORIZED_ROOTS_KEY: &str = "chat_v2.runtime.authorized_roots";
const WORKSPACE_ROOT_KEY: &str = "chat_v2.runtime.workspace_root";

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

const BROAD_FOLDER_NAMES: &[&str] = &[
    "desktop", "downloads", "documents", "桌面", "下载", "文档",
];
const HOME_PARENT_NAMES: &[&str] = &["users", "home"];
const BROAD_MAX_DEPTH: usize = 3;

/// 会话 temp 根下的写备份区目录名（`workspace_artifact_write` 覆盖前的旧内容存这里）。
pub const WRITE_BACKUP_DIR: &str = ".write_backups";

/// 进程内单调序号：同毫秒多次备份也能拿到不同文件名。
static WRITE_BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRootKind {
    Workspace,
    Authorized,
    SkillPackage,
    Artifact,
    Temp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRootAccess {
    ReadOnly,
    ReadWrite,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthorizedRootRecord {
    id: String,
    path: PathBuf,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceRootRecord {
    path: PathBuf,
    label: String,
}

pub fn safe_session_dir(session_id: &str) -> String {
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

fn configured_workspace_runtime_root(record: WorkspaceRootRecord) -> RuntimeRoot {
    RuntimeRoot {
        id: "workspace".to_string(),
        kind: RuntimeRootKind::Workspace,
        path: record.path,
        access: RuntimeRootAccess::ReadOnly,
        label: record.label,
        description: "User-selected workspace root. Read-only for agent runtime.".to_string(),
        session_scoped: false,
        configured: true,
    }
}

pub fn workspace_root(database: &crate::database::Database) -> Result<RuntimeRoot, String> {
    if let Some(record) = load_workspace_record(database)? {
        return Ok(configured_workspace_runtime_root(record));
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
    let path = base
        .join("chat_v2_artifacts")
        .join(safe_session_dir(session_id));
    if create {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create artifact root: {}", e))?;
    }
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
    let path = base.join("chat_v2_temp").join(safe_session_dir(session_id));
    if create {
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create temp root: {}", e))?;
    }
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
    let id = authorized_root_id(&canonical);
    let label = derive_authorized_root_label(&canonical, label);

    let mut records = load_authorized_records(database)?;
    if let Some(existing) = records.iter().find(|record| record.path == canonical) {
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

fn authorized_runtime_root(record: AuthorizedRootRecord) -> RuntimeRoot {
    RuntimeRoot {
        id: record.id,
        kind: RuntimeRootKind::Authorized,
        path: record.path,
        access: RuntimeRootAccess::ReadOnly,
        label: record.label,
        description: "User-authorized local directory. Read-only for agent runtime.".to_string(),
        session_scoped: false,
        configured: true,
    }
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

pub fn skill_package_root_by_id(
    skill_package_roots: &HashMap<String, String>,
    root_id: &str,
) -> Result<Option<RuntimeRoot>, String> {
    let Some(skill_id) = root_id.strip_prefix("skill:") else {
        return Ok(None);
    };
    let Some(path) = skill_package_roots.get(skill_id) else {
        return Ok(None);
    };
    skill_package_runtime_root(skill_id, path).map(Some)
}

pub fn authorized_roots(database: &crate::database::Database) -> Result<Vec<RuntimeRoot>, String> {
    load_authorized_records(database).map(|records| {
        records
            .into_iter()
            .map(authorized_runtime_root)
            .collect::<Vec<_>>()
    })
}

pub fn authorized_root_by_id(
    database: &crate::database::Database,
    root_id: &str,
) -> Result<Option<RuntimeRoot>, String> {
    Ok(load_authorized_records(database)?
        .into_iter()
        .find(|record| record.id == root_id)
        .map(authorized_runtime_root))
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
            skill_package_root_by_id(roots, other)?.ok_or_else(|| {
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
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    let canonical = canonicalize_workspace_dir(&path)?;
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

    save_workspace_record(
        &state.database,
        &WorkspaceRootRecord {
            path: canonical,
            label,
        },
    )?;

    chat_v2_list_runtime_roots(app, state, session_id).await
}

#[tauri::command]
pub async fn chat_v2_reset_workspace_root(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<RuntimeRoot>, String> {
    state
        .database
        .delete_setting(WORKSPACE_ROOT_KEY)
        .map_err(|e| format!("Failed to reset workspace runtime root: {}", e))?;

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
    let mut records = load_authorized_records(&state.database)?;
    let before = records.len();
    records.retain(|record| record.id != root_id);
    if records.len() == before {
        return Err("Authorized runtime root not found".to_string());
    }
    save_authorized_records(&state.database, &records)?;

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
    let root = runtime_root_by_id(app, database, session_id, None, root_id, create_session_roots)?;
    if !root.path.exists() {
        return Err("runtime root does not exist".to_string());
    }
    let root_canon = root
        .path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve runtime root: {}", e))?;
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
    state: State<'_, AppState>,
    session_id: String,
    relative_path: String,
) -> Result<serde_json::Value, String> {
    let relative = normalize_runtime_relative_path(Some(&relative_path))?;
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let root = artifact_root(&app, &session_id, false)?;
    if !root.path.exists() {
        return Err("No artifacts exist for this session yet".to_string());
    }
    let root_canon = root
        .path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve artifacts root: {}", e))?;
    let target = root_canon.join(&relative);
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Artifact does not exist: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Path escapes the artifacts root".to_string());
    }
    let metadata = fs::symlink_metadata(&target_canon)
        .map_err(|e| format!("Failed to inspect artifact: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to delete a symlink artifact".to_string());
    }
    if !metadata.is_file() {
        return Err("Only artifact files can be deleted, not directories".to_string());
    }
    fs::remove_file(&target_canon).map_err(|e| format!("Failed to delete artifact: {}", e))?;
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

/// 把即将被覆盖的旧产物内容写入 temp 根备份区，返回相对 temp 根的 backup_ref
/// （形如 `.write_backups/<毫秒时间戳>_<序号>_<原文件名>`，供撤销时恢复）。
pub fn create_write_backup(
    temp_root_path: &Path,
    original_file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let backup_dir = temp_root_path.join(WRITE_BACKUP_DIR);
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create write backup dir: {}", e))?;
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
    fs::write(&backup_path, bytes).map_err(|e| format!("Failed to write backup: {}", e))?;
    Ok(format!("{}/{}", WRITE_BACKUP_DIR, backup_name))
}

/// 校验 backup_ref 并解析为 temp 根备份区内的规范化绝对路径。
/// 只接受 `.write_backups/` 下的普通文件，拒绝绝对路径、`..` 与 symlink。
fn resolve_write_backup_source(
    temp_root_path: &Path,
    backup_ref: &str,
) -> Result<PathBuf, String> {
    let relative = normalize_runtime_relative_path(Some(backup_ref))?;
    let mut components = relative.components();
    match components.next() {
        Some(Component::Normal(part)) if part == std::ffi::OsStr::new(WRITE_BACKUP_DIR) => {}
        _ => return Err("backup_ref must point into the write backup area".to_string()),
    }
    if components.next().is_none() {
        return Err("backup_ref must point to a backup file".to_string());
    }
    let temp_canon = temp_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve temp root: {}", e))?;
    let source = temp_canon.join(&relative);
    let source_canon = source
        .canonicalize()
        .map_err(|e| format!("Backup does not exist: {}", e))?;
    if !source_canon.starts_with(&temp_canon) {
        return Err("backup_ref escapes the temp root".to_string());
    }
    let meta = fs::symlink_metadata(&source_canon)
        .map_err(|e| format!("Failed to inspect backup: {}", e))?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to restore from a symlink backup".to_string());
    }
    if !meta.is_file() {
        return Err("backup_ref must be a file".to_string());
    }
    Ok(source_canon)
}

/// 从备份把旧内容写回 artifacts 根内的目标文件，返回恢复的字节数。
/// `relative` 必须已经过 `normalize_runtime_relative_path` 归一化。
fn restore_artifact_from_backup(
    artifact_root_path: &Path,
    temp_root_path: &Path,
    relative: &Path,
    backup_ref: &str,
) -> Result<u64, String> {
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let source = resolve_write_backup_source(temp_root_path, backup_ref)?;
    let root_canon = artifact_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve artifacts root: {}", e))?;
    let target = root_canon.join(relative);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("Refusing to restore through a symlink".to_string());
        }
        if meta.is_dir() {
            return Err("Cannot restore file content to a directory".to_string());
        }
    }
    // 目标可能已被删除（撤销前用户手动删过），所以校验父目录仍在 artifacts 根内后重建
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("Path escapes the artifacts root".to_string());
        }
    }
    let bytes = fs::read(&source).map_err(|e| format!("Failed to read backup: {}", e))?;
    fs::write(&target, &bytes).map_err(|e| format!("Failed to restore artifact: {}", e))?;
    Ok(bytes.len() as u64)
}

/// 撤销一次新建写入：删除 artifacts 根内的目标文件（校验语义与 `chat_v2_delete_artifact` 一致）。
fn remove_artifact_file(artifact_root_path: &Path, relative: &Path) -> Result<(), String> {
    if relative.as_os_str().is_empty() {
        return Err("A relative artifact path is required".to_string());
    }
    let root_canon = artifact_root_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve artifacts root: {}", e))?;
    let target = root_canon.join(relative);
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("Artifact does not exist: {}", e))?;
    if !target_canon.starts_with(&root_canon) {
        return Err("Path escapes the artifacts root".to_string());
    }
    let metadata = fs::symlink_metadata(&target_canon)
        .map_err(|e| format!("Failed to inspect artifact: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to delete a symlink artifact".to_string());
    }
    if !metadata.is_file() {
        return Err("Only artifact files can be deleted, not directories".to_string());
    }
    fs::remove_file(&target_canon).map_err(|e| format!("Failed to delete artifact: {}", e))
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
) -> Result<serde_json::Value, String> {
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
            let bytes_restored =
                restore_artifact_from_backup(&root.path, &temp.path, &relative, backup_ref)?;
            Ok(serde_json::json!({
                "reverted": true,
                "mode": "restored",
                "root_id": root.id,
                "relative_path": relative_display,
                "bytes_restored": bytes_restored,
            }))
        }
        None => {
            remove_artifact_file(&root.path, &relative)?;
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
    let meta = fs::symlink_metadata(&target)
        .map_err(|e| format!("Failed to inspect file: {}", e))?;
    if !meta.is_file() {
        return Err("Only files can be previewed".to_string());
    }
    let max_bytes = max_bytes.unwrap_or(64 * 1024).clamp(1, 1024 * 1024) as usize;
    let bytes = fs::read(&target).map_err(|e| format!("Failed to read file: {}", e))?;
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

    #[test]
    fn sanitizes_session_dir() {
        assert_eq!(safe_session_dir("sess:abc/123"), "sess_abc_123");
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
        let path = PathBuf::from("C:/Users/example/materials");
        let id = authorized_root_id(&path);
        let root = authorized_runtime_root(AuthorizedRootRecord {
            id: id.clone(),
            path: path.clone(),
            label: "Materials".to_string(),
        });

        assert_eq!(root.id, id);
        assert_eq!(root.kind, RuntimeRootKind::Authorized);
        assert_eq!(root.access, RuntimeRootAccess::ReadOnly);
        assert_eq!(root.path, path);
        assert_eq!(root.label, "Materials");
        assert!(!root.session_scoped);
    }

    #[test]
    fn configured_workspace_roots_are_read_only_and_marked_configured() {
        let path = PathBuf::from("C:/Users/example/workspace");
        let root = configured_workspace_runtime_root(WorkspaceRootRecord {
            path: path.clone(),
            label: "Study Workspace".to_string(),
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

        let restored =
            restore_artifact_from_backup(&artifacts, &temp_root_path, &relative, &backup_ref)
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
            temp_dir.path().join("outside.txt").to_string_lossy().as_ref(),
        )
        .is_err());
        assert!(
            restore_artifact_from_backup(&artifacts, &temp_root_path, &relative, "../outside.txt")
                .is_err()
        );
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups/../loose.txt"
        )
        .is_err());
        assert!(
            restore_artifact_from_backup(&artifacts, &temp_root_path, &relative, "loose.txt")
                .is_err()
        );
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups"
        )
        .is_err());
        assert!(restore_artifact_from_backup(
            &artifacts,
            &temp_root_path,
            &relative,
            ".write_backups/missing.txt"
        )
        .is_err());
    }

    #[test]
    fn remove_artifact_file_only_deletes_regular_files_inside_root() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let artifacts = temp_dir.path().join("artifacts");
        fs::create_dir_all(artifacts.join("reports")).expect("create nested dir");
        let target = artifacts.join("reports").join("summary.md");
        fs::write(&target, "content").expect("write target");

        assert!(remove_artifact_file(&artifacts, Path::new("reports")).is_err());
        assert!(remove_artifact_file(&artifacts, Path::new("missing.md")).is_err());
        assert!(remove_artifact_file(&artifacts, Path::new("")).is_err());
        remove_artifact_file(&artifacts, &PathBuf::from("reports").join("summary.md"))
            .expect("delete file");
        assert!(!target.exists());
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
        assert_eq!(assess_authorized_root_risk("~"), AuthorizedRootRisk::Critical);
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
        let database = crate::database::Database::new(&db_path).expect("database");
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
}
