use crate::backup_common::{check_disk_space, copy_directory_safe, log_and_skip_entry_err};
use crate::models::AppError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tracing::{error, info, warn};

const LEGACY_MIGRATION_PENDING_FILE: &str = ".legacy_migration_pending";
const LEGACY_MIGRATION_COMPLETE_FILE: &str = ".legacy_migration_complete";
const PURGE_MARKER_FILE: &str = ".purge_on_next_start";
const RECOVERY_DIR: &str = "recovery";
const RECOVERY_BACKUPS_DIR: &str = "backups";
const SLOT_BACKUP_MIGRATION_JOURNAL: &str = ".slot_backup_migration.json";
const STARTUP_RECOVERY_INCIDENTS_DIR: &str = "incidents";
const STARTUP_RECOVERY_CURRENT_FILE: &str = "current-startup-incident.json";
const STARTUP_RECOVERY_MANIFEST_FILE: &str = "manifest.json";
const STARTUP_RECOVERY_JOURNAL_FILE: &str = "journal.json";
const STARTUP_RECOVERY_LEGACY_DIR: &str = "legacy-root";
const STARTUP_RECOVERY_SLOT_A_ARCHIVE: &str = "slotA-before-legacy";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreCutoverLease {
    pub target_slot: String,
    pub backup_id: String,
    pub created_at: String,
    #[serde(default)]
    pub activation_committed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Slot {
    A,
    B,
    /// 测试专用插槽 C（模拟生产环境的 A）
    C,
    /// 测试专用插槽 D（模拟生产环境的 B）
    D,
}

impl Slot {
    /// 判断是否为测试插槽
    pub fn is_test_slot(&self) -> bool {
        matches!(self, Slot::C | Slot::D)
    }

    /// 获取插槽名称
    pub fn name(&self) -> &'static str {
        match self {
            Slot::A => "slotA",
            Slot::B => "slotB",
            Slot::C => "slotC",
            Slot::D => "slotD",
        }
    }

    /// 从字符串解析插槽
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "slotA" | "A" => Some(Slot::A),
            "slotB" | "B" => Some(Slot::B),
            "slotC" | "C" => Some(Slot::C),
            "slotD" | "D" => Some(Slot::D),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SlotState {
    active: String,
    pending: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_cutover_pending: Option<RestoreCutoverLease>,
}

impl Default for SlotState {
    fn default() -> Self {
        Self {
            active: "slotA".to_string(),
            pending: None,
            restore_cutover_pending: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupRecoveryCandidate {
    pub id: String,
    pub exists: bool,
    pub has_data: bool,
    pub has_database: bool,
    pub size_bytes: u64,
    pub latest_modified: Option<String>,
    pub database_filenames: Vec<String>,
    #[serde(default)]
    pub core_database_filenames: Vec<String>,
    #[serde(default)]
    pub valid_core_database_filenames: Vec<String>,
    #[serde(default)]
    pub selectable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_block_reason: Option<String>,
    pub recommended: bool,
    pub recommendation_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupRecoveryIncident {
    pub incident_id: String,
    pub created_at: String,
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_candidate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_operation: Option<String>,
    #[serde(default)]
    pub retry_requires_restart: bool,
    pub candidates: Vec<StartupRecoveryCandidate>,
    #[serde(default)]
    legacy_entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupRecoveryStatus {
    pub recovery_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incident: Option<StartupRecoveryIncident>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupRecoveryResolveResponse {
    pub resolved: bool,
    pub restart_required: bool,
    pub selected_candidate: String,
    pub incident_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StartupRecoveryPointer {
    incident_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StartupRecoveryJournal {
    #[serde(default)]
    quarantined: BTreeSet<String>,
    #[serde(default)]
    restored_to_slot_a: BTreeSet<String>,
    #[serde(default)]
    slot_a_archived: bool,
}

pub struct StartupRecoveryState {
    base_dir: PathBuf,
    incident: Mutex<Option<StartupRecoveryIncident>>,
}

impl StartupRecoveryState {
    pub fn new(base_dir: PathBuf, incident: Option<StartupRecoveryIncident>) -> Self {
        Self {
            base_dir,
            incident: Mutex::new(incident),
        }
    }

    pub fn failed(base_dir: PathBuf, operation: &str, error: impl ToString) -> Self {
        Self::new(
            base_dir,
            Some(startup_recovery_failure_incident(operation, error)),
        )
    }

    pub fn is_recovery_required(&self) -> bool {
        self.incident
            .lock()
            .map(|incident| incident.as_ref().is_some_and(|item| !item.resolved))
            .unwrap_or(true)
    }

    pub fn set_failure(&self, operation: &str, error: impl ToString) {
        match self.incident.lock() {
            Ok(mut incident) => {
                *incident = Some(startup_recovery_failure_incident(operation, error));
            }
            Err(poisoned) => {
                *poisoned.into_inner() = Some(startup_recovery_failure_incident(operation, error));
            }
        }
    }

    fn status(&self) -> std::io::Result<StartupRecoveryStatus> {
        let incident = self
            .incident
            .lock()
            .map_err(|_| std::io::Error::other("启动恢复状态锁已损坏"))?
            .clone();
        Ok(StartupRecoveryStatus {
            recovery_required: incident.as_ref().is_some_and(|item| !item.resolved),
            incident,
        })
    }

    fn incidents(&self) -> std::io::Result<Vec<StartupRecoveryIncident>> {
        let incidents_dir = self
            .base_dir
            .join(RECOVERY_DIR)
            .join(STARTUP_RECOVERY_INCIDENTS_DIR);
        if !incidents_dir.is_dir() {
            return Ok(Vec::new());
        }

        let mut incidents = Vec::new();
        for entry in fs::read_dir(&incidents_dir)? {
            let entry = entry?;
            if !entry.path().is_dir() {
                continue;
            }
            let manifest = entry.path().join(STARTUP_RECOVERY_MANIFEST_FILE);
            if !manifest.is_file() {
                continue;
            }
            match read_json_file::<StartupRecoveryIncident>(&manifest, "启动恢复事件清单") {
                Ok(incident) => incidents.push(incident),
                Err(error) => warn!(
                    "[DataSpace] 跳过无法读取的恢复事件 {}: {}",
                    manifest.display(),
                    error
                ),
            }
        }
        incidents.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(incidents)
    }

    fn resolve(&self, candidate_id: &str) -> std::io::Result<StartupRecoveryResolveResponse> {
        let mut guard = self
            .incident
            .lock()
            .map_err(|_| std::io::Error::other("启动恢复状态锁已损坏"))?;
        let incident = guard.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "当前没有待处理的启动恢复事件")
        })?;
        let response =
            match resolve_startup_recovery_incident(&self.base_dir, incident, candidate_id) {
                Ok(response) => response,
                Err(error) => {
                    record_startup_recovery_error(
                        &self.base_dir,
                        incident,
                        "resolve_selection",
                        &error,
                    );
                    return Err(error);
                }
            };
        *guard = None;
        Ok(response)
    }

    fn retry_preflight(&self) -> StartupRecoveryStatus {
        if let Ok(current) = self.status() {
            if current
                .incident
                .as_ref()
                .and_then(|incident| incident.failed_operation.as_deref())
                .is_some_and(startup_failure_requires_restart)
            {
                return current;
            }
        }
        let next = match prepare_startup_recovery(&self.base_dir) {
            Ok(incident) => incident,
            Err(error) => Some(startup_recovery_failure_incident(
                "startup_preflight",
                error,
            )),
        };
        if let Ok(mut current) = self.incident.lock() {
            *current = next.clone();
        }
        StartupRecoveryStatus {
            recovery_required: next.as_ref().is_some_and(|incident| !incident.resolved),
            incident: next,
        }
    }

    fn incident_directory(&self, incident_id: &str) -> std::io::Result<PathBuf> {
        if incident_id.is_empty()
            || incident_id.contains('/')
            || incident_id.contains('\\')
            || incident_id == "."
            || incident_id == ".."
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "恢复事件 id 无效",
            ));
        }
        let incidents_root = self
            .base_dir
            .join(RECOVERY_DIR)
            .join(STARTUP_RECOVERY_INCIDENTS_DIR);
        let candidate = incidents_root.join(incident_id);
        if !candidate.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "恢复事件目录不存在",
            ));
        }
        let canonical_root = fs::canonicalize(&incidents_root)?;
        let canonical_candidate = fs::canonicalize(&candidate)?;
        if !canonical_candidate.starts_with(&canonical_root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "恢复事件目录越界",
            ));
        }
        Ok(canonical_candidate)
    }
}

fn startup_failure_requires_restart(operation: &str) -> bool {
    matches!(
        operation,
        "data_space_init" | "active_data_directory" | "startup_cleanup" | "startup_cleanup_marker"
    )
}

fn startup_recovery_failure_incident(
    operation: &str,
    error: impl ToString,
) -> StartupRecoveryIncident {
    StartupRecoveryIncident {
        incident_id: format!("startup-preflight-{}", uuid::Uuid::new_v4()),
        created_at: chrono::Utc::now().to_rfc3339(),
        resolved: false,
        resolved_at: None,
        selected_candidate: None,
        recovery_error: Some(error.to_string()),
        failed_operation: Some(operation.to_string()),
        retry_requires_restart: startup_failure_requires_restart(operation),
        candidates: Vec::new(),
        legacy_entries: Vec::new(),
    }
}

pub fn prepare_startup_recovery(
    base_dir: &Path,
) -> std::io::Result<Option<StartupRecoveryIncident>> {
    let recovery_dir = base_dir.join(RECOVERY_DIR);
    let pointer_path = recovery_dir.join(STARTUP_RECOVERY_CURRENT_FILE);

    if pointer_path.exists() {
        let pointer: StartupRecoveryPointer =
            read_json_file(&pointer_path, "启动恢复 current pointer")?;
        let incident_dir = startup_incident_dir(base_dir, &pointer.incident_id);
        let manifest_path = incident_dir.join(STARTUP_RECOVERY_MANIFEST_FILE);
        let mut incident: StartupRecoveryIncident =
            read_json_file(&manifest_path, "启动恢复事件清单")?;
        if incident.incident_id != pointer.incident_id {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "启动恢复 current pointer 与事件清单不匹配",
            ));
        }
        if incident.resolved {
            remove_file_if_exists(&pointer_path)?;
            sync_directory(&recovery_dir)?;
            return Ok(None);
        }
        if let Err(error) = quarantine_legacy_entries(base_dir, &mut incident) {
            record_startup_recovery_error(base_dir, &mut incident, "quarantine_legacy", &error);
            return Ok(Some(incident));
        }
        if let Some(candidate_id) = incident.selected_candidate.clone() {
            match resolve_startup_recovery_incident(base_dir, &mut incident, &candidate_id) {
                Ok(_) => return Ok(None),
                Err(error) => {
                    record_startup_recovery_error(
                        base_dir,
                        &mut incident,
                        "resume_selection",
                        &error,
                    );
                    return Ok(Some(incident));
                }
            }
        }
        return Ok(Some(incident));
    }

    let manager = DataSpaceManager::new(base_dir.to_path_buf());
    if manager.legacy_migration_complete_path().exists()
        || manager.legacy_migration_pending_path().exists()
    {
        return Ok(None);
    }

    let legacy_entries = legacy_root_entry_names(base_dir)?;
    if legacy_entries.is_empty() {
        return Ok(None);
    }
    let slot_a = manager.slot_dir(Slot::A);
    let slot_b = manager.slot_dir(Slot::B);
    let slot_b_has_data = DataSpaceManager::dir_has_data(&slot_b);
    let slot_a_collision = legacy_entries.iter().any(|name| slot_a.join(name).exists());
    if !slot_b_has_data && !slot_a_collision {
        return Ok(None);
    }

    fs::create_dir_all(&recovery_dir)?;
    let incidents_dir = recovery_dir.join(STARTUP_RECOVERY_INCIDENTS_DIR);
    fs::create_dir_all(&incidents_dir)?;
    sync_directory(&recovery_dir)?;
    let incident_id = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%6fZ"),
        uuid::Uuid::new_v4()
    );
    let incident_dir = startup_incident_dir(base_dir, &incident_id);
    fs::create_dir(&incident_dir)?;
    fs::create_dir(incident_dir.join(STARTUP_RECOVERY_LEGACY_DIR))?;
    sync_directory(&incidents_dir)?;

    let mut incident = StartupRecoveryIncident {
        incident_id: incident_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        resolved: false,
        resolved_at: None,
        selected_candidate: None,
        recovery_error: None,
        failed_operation: None,
        retry_requires_restart: false,
        candidates: inspect_startup_candidates(base_dir, &incident_id)?,
        legacy_entries,
    };
    atomic_write_json(
        &incident_dir.join(STARTUP_RECOVERY_MANIFEST_FILE),
        &incident,
    )?;
    atomic_write_json(
        &incident_dir.join(STARTUP_RECOVERY_JOURNAL_FILE),
        &StartupRecoveryJournal::default(),
    )?;
    atomic_write_json(
        &pointer_path,
        &StartupRecoveryPointer {
            incident_id: incident_id.clone(),
        },
    )?;

    if let Err(error) = quarantine_legacy_entries(base_dir, &mut incident) {
        record_startup_recovery_error(base_dir, &mut incident, "quarantine_legacy", &error);
    }
    Ok(Some(incident))
}

fn record_startup_recovery_error(
    base_dir: &Path,
    incident: &mut StartupRecoveryIncident,
    operation: &str,
    error: &std::io::Error,
) {
    incident.recovery_error = Some(error.to_string());
    incident.failed_operation = Some(operation.to_string());
    incident.retry_requires_restart = startup_failure_requires_restart(operation);
    let manifest =
        startup_incident_dir(base_dir, &incident.incident_id).join(STARTUP_RECOVERY_MANIFEST_FILE);
    if manifest.parent().is_some_and(Path::is_dir) {
        if let Err(write_error) = atomic_write_json(&manifest, incident) {
            warn!(
                "[DataSpace] 无法持久化恢复错误 {}: {}",
                manifest.display(),
                write_error
            );
        }
    }
}

fn startup_incident_dir(base_dir: &Path, incident_id: &str) -> PathBuf {
    base_dir
        .join(RECOVERY_DIR)
        .join(STARTUP_RECOVERY_INCIDENTS_DIR)
        .join(incident_id)
}

fn legacy_root_entry_names(base_dir: &Path) -> std::io::Result<Vec<String>> {
    if !base_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(base_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let display = name.to_str().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "旧版数据根目录包含非 UTF-8 文件名，无法建立恢复清单",
            )
        })?;
        if display != "slots"
            && display != "logs"
            && display != RECOVERY_DIR
            && display != PURGE_MARKER_FILE
        {
            names.push(display.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn quarantine_legacy_entries(
    base_dir: &Path,
    incident: &mut StartupRecoveryIncident,
) -> std::io::Result<()> {
    let incident_dir = startup_incident_dir(base_dir, &incident.incident_id);
    let legacy_dir = incident_dir.join(STARTUP_RECOVERY_LEGACY_DIR);
    fs::create_dir_all(&legacy_dir)?;
    let journal_path = incident_dir.join(STARTUP_RECOVERY_JOURNAL_FILE);
    let mut journal = read_recovery_journal(&journal_path)?;

    for name in &incident.legacy_entries {
        if journal.quarantined.contains(name) {
            continue;
        }
        move_path_preserving(&base_dir.join(name), &legacy_dir.join(name))?;
        journal.quarantined.insert(name.clone());
        atomic_write_json(&journal_path, &journal)?;
    }

    incident.candidates = inspect_startup_candidates(base_dir, &incident.incident_id)?;
    atomic_write_json(&incident_dir.join(STARTUP_RECOVERY_MANIFEST_FILE), incident)
}

fn read_recovery_journal(path: &Path) -> std::io::Result<StartupRecoveryJournal> {
    if path.exists() {
        read_json_file(path, "启动恢复操作日志")
    } else {
        let journal = StartupRecoveryJournal::default();
        atomic_write_json(path, &journal)?;
        Ok(journal)
    }
}

fn inspect_startup_candidates(
    base_dir: &Path,
    incident_id: &str,
) -> std::io::Result<Vec<StartupRecoveryCandidate>> {
    let incident_dir = startup_incident_dir(base_dir, incident_id);
    let mut candidates = vec![
        inspect_startup_candidate("legacy", &incident_dir.join(STARTUP_RECOVERY_LEGACY_DIR))?,
        inspect_startup_candidate("slotA", &base_dir.join("slots").join("slotA"))?,
        inspect_startup_candidate("slotB", &base_dir.join("slots").join("slotB"))?,
    ];

    let valid_active = fs::read(base_dir.join("slots").join("state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SlotState>(&bytes).ok())
        .map(|state| state.active)
        .filter(|active| active == "slotA" || active == "slotB");
    let recommendation = valid_active
        .as_deref()
        .and_then(|active| {
            candidates
                .iter()
                .find(|candidate| candidate.id == active && candidate.selectable)
                .map(|_| {
                    (
                        active.to_string(),
                        "state.json 中记录的活动插槽有效".to_string(),
                    )
                })
        })
        .or_else(|| {
            let valid_candidates: Vec<&StartupRecoveryCandidate> = candidates
                .iter()
                .filter(|candidate| candidate.selectable)
                .collect();
            (valid_candidates.len() == 1).then(|| {
                (
                    valid_candidates[0].id.clone(),
                    "仅此候选检测到受支持的核心数据库".to_string(),
                )
            })
        });

    for candidate in &mut candidates {
        if let Some((recommended_id, reason)) = &recommendation {
            candidate.recommended = candidate.id == *recommended_id;
            candidate.recommendation_reason = if candidate.recommended {
                reason.clone()
            } else {
                format!("推荐候选为 {recommended_id}")
            };
        } else {
            candidate.recommended = false;
            candidate.recommendation_reason = "候选时间线存在歧义，需要人工选择".to_string();
        }
    }
    Ok(candidates)
}

fn inspect_startup_candidate(id: &str, path: &Path) -> std::io::Result<StartupRecoveryCandidate> {
    let exists = path.exists();
    let has_data = DataSpaceManager::dir_has_data(path);
    let mut size_bytes = 0u64;
    let mut latest_modified = None;
    let mut database_filenames = Vec::new();
    if path.is_dir() {
        inspect_candidate_tree(
            path,
            path,
            &mut size_bytes,
            &mut latest_modified,
            &mut database_filenames,
        )?;
    }
    database_filenames.sort();
    let core_database_filenames: Vec<String> = database_filenames
        .iter()
        .filter(|filename| is_known_core_database(filename))
        .cloned()
        .collect();
    let valid_core_database_filenames: Vec<String> = core_database_filenames
        .iter()
        .filter(|filename| is_valid_sqlite_database(&path.join(filename)))
        .cloned()
        .collect();
    let selectable = !valid_core_database_filenames.is_empty();
    Ok(StartupRecoveryCandidate {
        id: id.to_string(),
        exists,
        has_data,
        has_database: !database_filenames.is_empty(),
        size_bytes,
        latest_modified: latest_modified.map(|time| {
            let time: chrono::DateTime<chrono::Utc> = time.into();
            time.to_rfc3339()
        }),
        database_filenames,
        core_database_filenames,
        valid_core_database_filenames,
        selectable,
        selection_block_reason: (!selectable)
            .then(|| "未检测到 Deep Student 核心数据库".to_string()),
        recommended: false,
        recommendation_reason: String::new(),
    })
}

fn is_known_core_database(relative: &str) -> bool {
    matches!(
        relative.replace('\\', "/").to_ascii_lowercase().as_str(),
        "mistakes.db" | "chat_v2.db" | "llm_usage.db" | "databases/vfs.db"
    )
}

fn is_valid_sqlite_database(path: &Path) -> bool {
    let connection = match rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            warn!(
                "[DataSpace] 核心数据库无法只读打开 {}: {}",
                path.display(),
                error
            );
            return false;
        }
    };
    match connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
        Ok(result) if result.eq_ignore_ascii_case("ok") => true,
        Ok(result) => {
            warn!(
                "[DataSpace] 核心数据库完整性检查失败 {}: {}",
                path.display(),
                result
            );
            false
        }
        Err(error) => {
            warn!(
                "[DataSpace] 核心数据库完整性检查无法完成 {}: {}",
                path.display(),
                error
            );
            false
        }
    }
}

fn inspect_candidate_tree(
    root: &Path,
    directory: &Path,
    size_bytes: &mut u64,
    latest_modified: &mut Option<std::time::SystemTime>,
    database_filenames: &mut Vec<String>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if let Ok(modified) = metadata.modified() {
            if latest_modified.is_none_or(|current| modified > current) {
                *latest_modified = Some(modified);
            }
        }
        if metadata.is_dir() {
            inspect_candidate_tree(root, &path, size_bytes, latest_modified, database_filenames)?;
        } else if metadata.is_file() {
            *size_bytes = size_bytes.saturating_add(metadata.len());
            let filename = entry.file_name().to_string_lossy().to_lowercase();
            if filename.ends_with(".db")
                || filename.ends_with(".sqlite")
                || filename.ends_with(".sqlite3")
            {
                database_filenames.push(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn resolve_startup_recovery_incident(
    base_dir: &Path,
    incident: &mut StartupRecoveryIncident,
    candidate_id: &str,
) -> std::io::Result<StartupRecoveryResolveResponse> {
    if incident.resolved {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "启动恢复事件已经解决",
        ));
    }
    if !matches!(candidate_id, "legacy" | "slotA" | "slotB") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "候选 id 必须是 legacy、slotA 或 slotB",
        ));
    }
    if let Some(started_candidate) = incident.selected_candidate.as_deref() {
        if started_candidate != candidate_id {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("恢复事件已开始选择 {started_candidate}，不能改选 {candidate_id}"),
            ));
        }
    }

    incident.candidates = inspect_startup_candidates(base_dir, &incident.incident_id)?;
    incident.recovery_error = None;
    incident.failed_operation = None;
    incident.retry_requires_restart = false;
    if incident.selected_candidate.is_none() {
        let selected = incident
            .candidates
            .iter()
            .find(|candidate| candidate.id == candidate_id)
            .ok_or_else(|| std::io::Error::other("恢复候选不存在"))?;
        if !selected.selectable {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("恢复候选 {candidate_id} 不包含受支持的核心数据库，拒绝将其激活"),
            ));
        }
        incident.selected_candidate = Some(candidate_id.to_string());
        atomic_write_json(
            &startup_incident_dir(base_dir, &incident.incident_id)
                .join(STARTUP_RECOVERY_MANIFEST_FILE),
            incident,
        )?;
    }

    if candidate_id == "legacy" {
        restore_legacy_candidate(base_dir, incident)?;
    } else {
        activate_startup_slot(base_dir, candidate_id)?;
    }

    incident.resolved = true;
    incident.resolved_at = Some(chrono::Utc::now().to_rfc3339());
    let incident_dir = startup_incident_dir(base_dir, &incident.incident_id);
    atomic_write_json(&incident_dir.join(STARTUP_RECOVERY_MANIFEST_FILE), incident)?;
    let pointer_path = base_dir
        .join(RECOVERY_DIR)
        .join(STARTUP_RECOVERY_CURRENT_FILE);
    remove_file_if_exists(&pointer_path)?;
    sync_directory(&base_dir.join(RECOVERY_DIR))?;

    Ok(StartupRecoveryResolveResponse {
        resolved: true,
        restart_required: true,
        selected_candidate: candidate_id.to_string(),
        incident_id: incident.incident_id.clone(),
    })
}

fn activate_startup_slot(base_dir: &Path, candidate_id: &str) -> std::io::Result<()> {
    let manager = DataSpaceManager::new(base_dir.to_path_buf());
    fs::create_dir_all(manager.slots_dir())?;
    let state = SlotState {
        active: candidate_id.to_string(),
        pending: None,
        restore_cutover_pending: None,
    };
    manager.write_state(&state)?;
    finish_legacy_migration(&manager)
}

fn restore_legacy_candidate(
    base_dir: &Path,
    incident: &StartupRecoveryIncident,
) -> std::io::Result<()> {
    let manager = DataSpaceManager::new(base_dir.to_path_buf());
    fs::create_dir_all(manager.slots_dir())?;
    let incident_dir = startup_incident_dir(base_dir, &incident.incident_id);
    let archive_dir = incident_dir.join(STARTUP_RECOVERY_SLOT_A_ARCHIVE);
    let slot_a = manager.slot_dir(Slot::A);
    let journal_path = incident_dir.join(STARTUP_RECOVERY_JOURNAL_FILE);
    let mut journal = read_recovery_journal(&journal_path)?;

    if !journal.slot_a_archived {
        if slot_a.exists() {
            move_path_preserving(&slot_a, &archive_dir)?;
        }
        journal.slot_a_archived = true;
        atomic_write_json(&journal_path, &journal)?;
    }
    fs::create_dir_all(&slot_a)?;
    sync_directory(manager.slots_dir().as_path())?;

    let legacy_dir = incident_dir.join(STARTUP_RECOVERY_LEGACY_DIR);
    for name in &incident.legacy_entries {
        if journal.restored_to_slot_a.contains(name) {
            continue;
        }
        move_path_preserving(&legacy_dir.join(name), &slot_a.join(name))?;
        journal.restored_to_slot_a.insert(name.clone());
        atomic_write_json(&journal_path, &journal)?;
    }

    manager.write_state(&SlotState {
        active: "slotA".to_string(),
        pending: None,
        restore_cutover_pending: None,
    })?;
    finish_legacy_migration(&manager)
}

fn finish_legacy_migration(manager: &DataSpaceManager) -> std::io::Result<()> {
    fs::create_dir_all(manager.slots_dir())?;
    atomic_write_bytes(&manager.legacy_migration_complete_path(), b"1")?;
    remove_file_if_exists(&manager.legacy_migration_pending_path())?;
    sync_directory(&manager.slots_dir())
}

fn move_path_preserving(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.exists() {
        if source.exists() {
            if !paths_equal(source, destination)? {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "恢复移动发现同名异内容条目，拒绝覆盖: {} -> {}",
                        source.display(),
                        destination.display()
                    ),
                ));
            }
            remove_path(source)?;
            if let Some(parent) = source.parent() {
                sync_directory(parent)?;
            }
        }
        return Ok(());
    }
    if !source.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "恢复移动的源和目标均不存在: {} -> {}",
                source.display(),
                destination.display()
            ),
        ));
    }
    let destination_parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("恢复移动目标缺少父目录"))?;
    fs::create_dir_all(destination_parent)?;
    if fs::rename(source, destination).is_ok() {
        sync_directory(destination_parent)?;
        if let Some(source_parent) = source.parent() {
            sync_directory(source_parent)?;
        }
        return Ok(());
    }

    let temporary = destination_parent.join(format!(
        ".moving-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    if temporary.exists() {
        remove_path(&temporary)?;
    }
    copy_path_durable(source, &temporary)?;
    if !paths_equal(source, &temporary)? {
        remove_path(&temporary)?;
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("恢复移动复制校验失败: {}", source.display()),
        ));
    }
    fs::rename(&temporary, destination)?;
    sync_directory(destination_parent)?;
    remove_path(source)?;
    if let Some(source_parent) = source.parent() {
        sync_directory(source_parent)?;
    }
    Ok(())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(
    path: &Path,
    description: &str,
) -> std::io::Result<T> {
    serde_json::from_slice(&fs::read(path)?).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("解析{description}失败: {error}"),
        )
    })
}

fn remove_file_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("持久化路径缺少父目录"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".durable-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .into_temp_path()
        .persist(path)
        .map_err(|error| error.error)?;
    sync_directory(parent)
}

pub struct DataSpaceManager {
    base_dir: PathBuf,
}

impl DataSpaceManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn slots_dir(&self) -> PathBuf {
        self.base_dir.join("slots")
    }
    fn state_path(&self) -> PathBuf {
        self.slots_dir().join("state.json")
    }
    fn legacy_migration_pending_path(&self) -> PathBuf {
        self.slots_dir().join(LEGACY_MIGRATION_PENDING_FILE)
    }
    fn legacy_migration_complete_path(&self) -> PathBuf {
        self.slots_dir().join(LEGACY_MIGRATION_COMPLETE_FILE)
    }
    pub fn slot_dir(&self, slot: Slot) -> PathBuf {
        self.slots_dir().join(slot.name())
    }

    /// 获取测试插槽目录
    pub fn test_slot_dir(&self, slot: Slot) -> PathBuf {
        assert!(slot.is_test_slot(), "只能获取测试插槽 C/D 的目录");
        self.slot_dir(slot)
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn recovery_backups_dir(&self) -> PathBuf {
        self.base_dir.join(RECOVERY_DIR).join(RECOVERY_BACKUPS_DIR)
    }

    pub fn ensure_layout(&self) -> std::io::Result<()> {
        // 创建生产插槽 A/B
        fs::create_dir_all(self.slot_dir(Slot::A))?;
        fs::create_dir_all(self.slot_dir(Slot::B))?;
        // 创建测试插槽 C/D（用于真实的端到端测试）
        fs::create_dir_all(self.slot_dir(Slot::C))?;
        fs::create_dir_all(self.slot_dir(Slot::D))?;
        if !self.state_path().exists() {
            let st = SlotState::default();
            fs::create_dir_all(self.slots_dir())?;
            // 使用原子写入，即使首次写入也要保证安全
            self.write_state(&st)?;
        }
        // 一次性迁移：把旧版根目录数据迁入 slotA。
        //
        // 不能只依赖“slotA/slotB 都为空”：旧实现发生部分失败后 slotA 已非空，
        // 后续启动会永久跳过剩余数据。现在使用 pending/complete journal：
        // - pending 存在表示上次迁移未完成，且应用没有继续打开业务库；
        // - complete 仅在所有根目录条目迁移完成后写入；
        // - 老版本留下的部分迁移会继续处理仍位于根目录、且目标不存在的条目；
        // - 源/目标同时存在且没有本版本 pending 证明时 fail-close，避免覆盖用户
        //   在残缺 slotA 上继续产生的新数据。
        let slot_a = self.slot_dir(Slot::A);
        let slot_b = self.slot_dir(Slot::B);
        let slot_b_empty = fs::read_dir(&slot_b)
            .map(|mut it| it.next().is_none())
            .unwrap_or(true);
        let complete_path = self.legacy_migration_complete_path();
        if !complete_path.exists() {
            let pending_path = self.legacy_migration_pending_path();
            let retrying_owned_attempt = pending_path.exists();
            let mut legacy_entries = Vec::new();
            for entry in fs::read_dir(&self.base_dir)? {
                let entry = entry?;
                let should_migrate = {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    name != "slots"
                        && name != "logs"
                        && name != RECOVERY_DIR
                        && name != PURGE_MARKER_FILE
                };
                if should_migrate {
                    legacy_entries.push(entry);
                }
            }

            if legacy_entries.is_empty() {
                fs::write(&complete_path, b"1")?;
                if pending_path.exists() {
                    fs::remove_file(&pending_path)?;
                }
                self.migrate_legacy_slot_backups()?;
                return Ok(());
            }

            if !slot_b_empty && !retrying_owned_attempt {
                return Err(std::io::Error::other(format!(
                    "检测到旧版根目录仍有 {} 个数据条目，但 slotB 已包含数据；为避免把不同时间线静默合并，已停止启动，请先备份并人工确认",
                    legacy_entries.len()
                )));
            }

            fs::write(&pending_path, b"1")?;
            info!("[DataSpace] 检测到首次启用双空间模式，开始数据迁移到 slotA...");
            let mut migration_errors: Vec<String> = Vec::new();

            for en in legacy_entries {
                let p = en.path();
                let dst = slot_a.join(en.file_name());

                if dst.exists() {
                    if retrying_owned_attempt {
                        let cleanup = if dst.is_dir() {
                            fs::remove_dir_all(&dst)
                        } else {
                            fs::remove_file(&dst)
                        };
                        if let Err(e) = cleanup {
                            let msg = format!(
                                "[DataSpace] 清理上次未完成迁移的目标失败 {:?}: {}",
                                dst, e
                            );
                            error!("{}", msg);
                            migration_errors.push(msg);
                            continue;
                        }
                    } else {
                        let msg = format!(
                            "[DataSpace] 旧版部分迁移存在源/目标冲突 {:?} -> {:?}，拒绝覆盖可能已更新的数据",
                            p, dst
                        );
                        error!("{}", msg);
                        migration_errors.push(msg);
                        continue;
                    }
                }

                // 尝试重命名，失败则复制
                if fs::rename(&p, &dst).is_err() {
                    if p.is_dir() {
                        // P1 修复: 使用安全版本复制，防止符号链接攻击
                        match copy_directory_safe(&p, &slot_a) {
                            Ok(_) => {
                                if let Err(e) = fs::remove_dir_all(&p) {
                                    let msg =
                                        format!("[DataSpace] 迁移后清理源目录失败 {:?}: {}", p, e);
                                    error!("{}", msg);
                                    migration_errors.push(msg);
                                }
                            }
                            Err(e) => {
                                let msg = format!("[DataSpace] 复制目录失败 {:?}: {}", p, e);
                                error!("{}", msg);
                                migration_errors.push(msg);
                            }
                        }
                    } else {
                        if let Err(e) = fs::create_dir_all(&slot_a) {
                            let msg = format!("[DataSpace] 创建目标目录失败 {:?}: {}", slot_a, e);
                            error!("{}", msg);
                            migration_errors.push(msg);
                            continue;
                        }
                        match fs::copy(&p, &dst) {
                            Ok(_) => {
                                if let Err(e) = fs::remove_file(&p) {
                                    let msg =
                                        format!("[DataSpace] 迁移后清理源文件失败 {:?}: {}", p, e);
                                    error!("{}", msg);
                                    migration_errors.push(msg);
                                }
                            }
                            Err(e) => {
                                let msg =
                                    format!("[DataSpace] 复制文件失败 {:?} -> {:?}: {}", p, dst, e);
                                error!("{}", msg);
                                migration_errors.push(msg);
                            }
                        }
                    }
                }
            }

            if !migration_errors.is_empty() {
                // P1 修复: 迁移失败时返回错误而非静默继续
                let error_summary = migration_errors.join("; ");
                error!(
                    "[DataSpace] 数据迁移过程中发生 {} 个错误，部分数据可能未迁移成功: {}",
                    migration_errors.len(),
                    error_summary
                );
                return Err(std::io::Error::other(format!(
                    "数据迁移失败 ({} 个错误): {}",
                    migration_errors.len(),
                    error_summary
                )));
            } else {
                fs::write(&complete_path, b"1")?;
                fs::remove_file(&pending_path)?;
                info!("[DataSpace] 数据迁移完成");
            }
        }
        self.migrate_legacy_slot_backups()?;
        Ok(())
    }

    /// 把旧版槽内备份移到不参与 A/B 切槽的 recovery/backups。
    ///
    /// 每个顶层产物都按 copy -> byte verify -> fsync -> journal -> delete-source
    /// 的顺序迁移。任一步崩溃后重跑都会先核对既有目标，因此不会覆盖另一份
    /// 同名但内容不同的备份，也不会在目标未持久化前删除唯一源。
    fn migrate_legacy_slot_backups(&self) -> std::io::Result<()> {
        use std::collections::BTreeSet;

        let recovery_dir = self.base_dir.join(RECOVERY_DIR);
        let destination_root = self.recovery_backups_dir();
        fs::create_dir_all(&destination_root)?;
        sync_directory(&recovery_dir)?;

        let journal_path = recovery_dir.join(SLOT_BACKUP_MIGRATION_JOURNAL);
        let mut journal: BTreeSet<String> = if journal_path.exists() {
            serde_json::from_slice(&fs::read(&journal_path)?).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("解析槽内备份迁移日志失败: {}", error),
                )
            })?
        } else {
            BTreeSet::new()
        };

        for slot in [Slot::A, Slot::B] {
            let source_root = self.slot_dir(slot).join("backups");
            if !source_root.is_dir() {
                continue;
            }

            for entry in fs::read_dir(&source_root)? {
                let entry = entry?;
                let source = entry.path();
                let destination = destination_root.join(entry.file_name());
                let journal_key =
                    format!("{}/{}", slot.name(), entry.file_name().to_string_lossy());

                if destination.exists() {
                    if !paths_equal(&source, &destination)? {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::AlreadyExists,
                            format!(
                                "槽内备份迁移发现同名异内容产物，拒绝覆盖: {} -> {}",
                                source.display(),
                                destination.display()
                            ),
                        ));
                    }
                } else {
                    let temporary = destination_root.join(format!(
                        ".migrating-{}-{}",
                        slot.name(),
                        entry.file_name().to_string_lossy()
                    ));
                    if temporary.exists() {
                        remove_path(&temporary)?;
                    }
                    copy_path_durable(&source, &temporary)?;
                    if !paths_equal(&source, &temporary)? {
                        remove_path(&temporary)?;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("槽内备份复制校验失败: {}", source.display()),
                        ));
                    }
                    fs::rename(&temporary, &destination)?;
                    sync_directory(&destination_root)?;
                }

                if journal.insert(journal_key) {
                    atomic_write_json(&journal_path, &journal)?;
                    sync_directory(&recovery_dir)?;
                }
                remove_path(&source)?;
                sync_directory(&source_root)?;
            }

            if fs::read_dir(&source_root)?.next().is_none() {
                fs::remove_dir(&source_root)?;
                sync_directory(&self.slot_dir(slot))?;
            }
        }

        Ok(())
    }

    fn read_state(&self) -> std::io::Result<SlotState> {
        let state_path = self.state_path();
        let tmp_path = self.slots_dir().join("state.json.tmp");

        // 1. 尝试从 state.json 读取
        match fs::read_to_string(&state_path) {
            Ok(content) => match serde_json::from_str::<SlotState>(&content) {
                Ok(st) => return Ok(st),
                Err(e) => {
                    error!(
                        "[DataSpace] state.json 内容损坏，解析失败: {}。尝试从 .tmp 文件恢复...",
                        e
                    );
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // state.json 不存在，继续尝试 .tmp 和推断
                warn!("[DataSpace] state.json 不存在: {}", e);
            }
            Err(e) => {
                error!(
                    "[DataSpace] 读取 state.json 失败: {}。尝试从 .tmp 文件恢复...",
                    e
                );
            }
        }

        // 2. 尝试从 state.json.tmp（原子写入的中间文件）恢复
        if tmp_path.exists() {
            match fs::read_to_string(&tmp_path) {
                Ok(content) => match serde_json::from_str::<SlotState>(&content) {
                    Ok(st) => {
                        warn!(
                            "[DataSpace] 已从 state.json.tmp 恢复状态 (active={})",
                            st.active
                        );
                        // 将恢复的状态写回 state.json，防止下次启动时再次走恢复流程
                        if let Err(e) = self.write_state(&st) {
                            error!("[DataSpace] 恢复后回写 state.json 失败: {}", e);
                        } else if let Err(e) = fs::remove_file(&tmp_path) {
                            if e.kind() != std::io::ErrorKind::NotFound {
                                warn!("[DataSpace] 清理旧 state.json.tmp 失败: {}", e);
                            }
                        }
                        return Ok(st);
                    }
                    Err(e) => {
                        error!("[DataSpace] state.json.tmp 也已损坏: {}", e);
                    }
                },
                Err(e) => {
                    error!("[DataSpace] 读取 state.json.tmp 失败: {}", e);
                }
            }
        }

        // 3. 两个文件都损坏/不存在，通过检查 slot 目录推断活跃空间
        let inferred = self.infer_active_slot_from_dirs();
        warn!(
            "[DataSpace] state.json 和 .tmp 均不可用，通过目录推断活跃空间为: {}",
            inferred.active
        );
        // 将推断结果持久化
        if let Err(e) = self.write_state(&inferred) {
            error!("[DataSpace] 推断后写入 state.json 失败: {}", e);
        }
        Ok(inferred)
    }

    /// 当 state.json 和 .tmp 都损坏时，通过检查 slot 目录的存在和内容推断活跃空间
    fn infer_active_slot_from_dirs(&self) -> SlotState {
        let slot_a_dir = self.slot_dir(Slot::A);
        let slot_b_dir = self.slot_dir(Slot::B);

        let slot_a_valid = Self::dir_has_data(&slot_a_dir);
        let slot_b_valid = Self::dir_has_data(&slot_b_dir);

        let active = match (slot_a_valid, slot_b_valid) {
            (true, false) => {
                info!("[DataSpace] 推断: 仅 slotA 包含有效数据，设为活跃");
                "slotA"
            }
            (false, true) => {
                info!("[DataSpace] 推断: 仅 slotB 包含有效数据，设为活跃");
                "slotB"
            }
            (true, true) => {
                // 两个 slot 都有数据，比较最近修改时间以推断
                let a_mtime = Self::dir_latest_mtime(&slot_a_dir);
                let b_mtime = Self::dir_latest_mtime(&slot_b_dir);
                if b_mtime > a_mtime {
                    info!("[DataSpace] 推断: slotA 和 slotB 均有数据，slotB 修改更新，设为活跃");
                    "slotB"
                } else {
                    info!("[DataSpace] 推断: slotA 和 slotB 均有数据，默认 slotA 为活跃");
                    "slotA"
                }
            }
            (false, false) => {
                info!("[DataSpace] 推断: 两个 slot 均无数据，默认 slotA");
                "slotA"
            }
        };

        SlotState {
            active: active.to_string(),
            pending: None,
            restore_cutover_pending: None,
        }
    }

    /// 检查目录是否存在且包含文件/子目录
    fn dir_has_data(dir: &Path) -> bool {
        dir.is_dir()
            && fs::read_dir(dir)
                .map(|mut it| it.next().is_some())
                .unwrap_or(false)
    }

    /// 获取目录下文件的最近修改时间（秒级时间戳），用于推断活跃空间
    fn dir_latest_mtime(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.metadata().ok())
                    .filter_map(|m| m.modified().ok())
                    .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    // ========================================================================
    // 空间大小计算与磁盘空间检查
    // ========================================================================

    /// 递归计算目录总大小（字节）
    pub fn calculate_dir_size(dir: &Path) -> std::io::Result<u64> {
        let mut total: u64 = 0;
        if !dir.is_dir() {
            return Ok(0);
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                total += Self::calculate_dir_size(&entry.path())?;
            } else if metadata.is_file() {
                total += metadata.len();
            }
            // 跳过符号链接，防止循环引用
        }
        Ok(total)
    }

    /// 计算指定 slot 的占用空间（字节）
    pub fn slot_size(&self, slot: Slot) -> std::io::Result<u64> {
        Self::calculate_dir_size(&self.slot_dir(slot))
    }

    /// 检查目标分区是否有足够空间容纳源 slot 的数据
    ///
    /// 使用 backup_common 的 check_disk_space（包含 20% 安全余量）
    pub fn check_space_for_switch(&self, source: Slot, target_dir: &Path) -> std::io::Result<()> {
        let source_size = self.slot_size(source)?;
        info!(
            "[DataSpace] 源插槽 {} 大小: {:.2} MB",
            source.name(),
            source_size as f64 / 1024.0 / 1024.0
        );

        // 使用 backup_common 的磁盘空间检查（含 20% 余量）
        check_disk_space(target_dir, source_size)
            .map_err(|e| std::io::Error::other(format!("磁盘空间检查失败: {}", e.message)))?;

        Ok(())
    }

    // ========================================================================
    // Slot 目录完整性验证
    // ========================================================================

    /// 验证 slot 目录的完整性。
    ///
    /// 检查项：
    /// 1. 目录是否存在
    /// 2. 目录是否包含数据库文件（*.db 或 *.sqlite）
    /// 3. 目录是否包含必要子目录（如 images 等，可选检查）
    ///
    /// 返回 `SlotIntegrityReport` 包含详细检查结果。
    pub fn verify_slot_integrity(&self, slot: Slot) -> SlotIntegrityReport {
        let dir = self.slot_dir(slot);
        let mut report = SlotIntegrityReport {
            slot: slot.name().to_string(),
            dir_path: dir.to_string_lossy().to_string(),
            exists: false,
            has_data: false,
            has_database: false,
            database_files: Vec::new(),
            subdirectories: Vec::new(),
            total_size_bytes: 0,
            file_count: 0,
            issues: Vec::new(),
        };

        // 1. 检查目录是否存在
        if !dir.is_dir() {
            report.issues.push("插槽目录不存在".to_string());
            return report;
        }
        report.exists = true;

        // 2. 检查是否包含数据
        report.has_data = Self::dir_has_data(&dir);
        if !report.has_data {
            report.issues.push("插槽目录为空".to_string());
            return report;
        }

        // 3. 扫描目录内容
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                if path.is_dir() {
                    report.subdirectories.push(name);
                } else if path.is_file() {
                    report.file_count += 1;
                    if let Ok(meta) = entry.metadata() {
                        report.total_size_bytes += meta.len();
                    }
                    // 检查数据库文件
                    let lower = name.to_lowercase();
                    if lower.ends_with(".db")
                        || lower.ends_with(".sqlite")
                        || lower.ends_with(".sqlite3")
                    {
                        report.database_files.push(name);
                    }
                }
            }
        }

        // 4. 递归计算子目录大小
        for subdir_name in &report.subdirectories {
            let subdir_path = dir.join(subdir_name);
            if let Ok(size) = Self::calculate_dir_size(&subdir_path) {
                report.total_size_bytes += size;
            }
        }

        // 5. 检查是否包含数据库文件
        report.has_database = !report.database_files.is_empty();
        if !report.has_database {
            report
                .issues
                .push("未找到数据库文件 (*.db / *.sqlite / *.sqlite3)".to_string());
        }

        report
    }

    fn write_state(&self, st: &SlotState) -> std::io::Result<()> {
        // P2 修复: 序列化理论上不会失败，但仍使用 map_err 转换为 io::Error
        let s = serde_json::to_string_pretty(st).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("序列化状态失败: {}", e),
            )
        })?;
        self.atomic_write_state_file(&s)
    }

    /// 原子写入 state.json：同目录随机临时文件 fsync 后持久化覆盖。
    ///
    /// `TempPath::persist` 在 Windows 使用可覆盖既有目标的原子持久化语义，避免
    /// `std::fs::rename` 因 state.json 已存在而失败；崩溃前旧 state 仍保持完整。
    fn atomic_write_state_file(&self, content: &str) -> std::io::Result<()> {
        use std::io::Write;

        let target = self.state_path();
        let mut temporary = tempfile::Builder::new()
            .prefix(".state-")
            .suffix(".tmp")
            .tempfile_in(self.slots_dir())?;
        temporary.write_all(content.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary
            .into_temp_path()
            .persist(&target)
            .map_err(|error| error.error)?;

        // fsync 父目录，确保目录条目更新持久化（防止断电后目录项丢失）
        #[cfg(unix)]
        {
            if let Ok(dir) = fs::File::open(self.slots_dir()) {
                let _ = dir.sync_all();
            }
        }

        Ok(())
    }

    pub fn initialize_on_start(&self) -> std::io::Result<()> {
        self.ensure_layout()?;
        let mut st = self.read_state()?;
        if let Some(pending) = st.pending.take() {
            // 在应用 pending 切换之前，验证目标 slot 目录有效
            if let Some(target_slot) = Slot::from_name(&pending) {
                let target_dir = self.slot_dir(target_slot);
                if target_dir.is_dir() && Self::dir_has_data(&target_dir) {
                    info!(
                        "[DataSpace] 启动时应用 pending 切换: {} -> {}",
                        st.active, pending
                    );
                    st.active = pending;
                } else {
                    error!(
                        "[DataSpace] pending 切换目标 {} 目录无效或为空，取消切换，保持 {}",
                        pending, st.active
                    );
                }
            } else {
                error!(
                    "[DataSpace] pending 切换目标名称无效: {}，取消切换",
                    pending
                );
            }
            self.write_state(&st)?;
        }
        if let Some(lease) = &st.restore_cutover_pending {
            if st.active != lease.target_slot {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "恢复维护租约目标 {} 未激活（当前 {}），拒绝在不确定数据槽上启动",
                        lease.target_slot, st.active
                    ),
                ));
            }
        }
        // pending 已原子提交后，匹配当前活动槽的 rollback 才失去恢复价值。
        // 失败恢复只会在非活动槽留下 trash，因此这里不会误删尚未提交的回滚点。
        if let Some(active_slot) = Slot::from_name(&st.active) {
            self.cleanup_restore_trash(active_slot)?;
        }
        Ok(())
    }

    pub fn active_slot(&self) -> Slot {
        if let Ok(st) = self.read_state() {
            if st.active == "slotB" {
                Slot::B
            } else {
                Slot::A
            }
        } else {
            Slot::A
        }
    }

    pub fn inactive_slot(&self) -> Slot {
        match self.active_slot() {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
            // 测试插槽不参与生产环境的切换
            Slot::C => Slot::D,
            Slot::D => Slot::C,
        }
    }

    pub fn active_dir(&self) -> PathBuf {
        self.slot_dir(self.active_slot())
    }
    pub fn inactive_dir(&self) -> PathBuf {
        self.slot_dir(self.inactive_slot())
    }

    /// 删除指定生产槽此前遗留的恢复 rollback 目录。
    ///
    /// 每次新恢复只保留本次刚生成的一份 rollback；成功提交后调用方还会删除
    /// 该份目录，从而避免完整数据槽副本无限累积。
    pub fn cleanup_restore_trash(&self, target: Slot) -> std::io::Result<usize> {
        if target.is_test_slot() {
            return Ok(0);
        }
        let prefix = format!("{}.trash-", target.name());
        let mut removed = 0usize;
        for entry in fs::read_dir(self.slots_dir())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
            removed += 1;
        }
        Ok(removed)
    }

    /// 恢复前清空目标插槽（审阅 15-backup-dataspace P1-2）。
    ///
    /// 非活跃插槽通常保留着上一次切换前的完整旧数据空间；恢复只覆盖备份中
    /// 存在的文件，备份未包含的内容（如精简备份不含 `llm_usage.db`、资产目录、
    /// 旧的 `ws_*.db`）会原样残留，切换后用户得到"备份数据 + 旧插槽残留"的
    /// 混合体。恢复写入前应先调用本方法清场。
    ///
    /// 行为：
    /// 1. 拒绝清空当前**活跃**插槽（防误用——活跃插槽数据库被连接池持有）；
    /// 2. 若目标插槽有残留内容，整体移动到 `slots/<slot>.trash-<时间戳>`
    ///    作为兜底（rename 快速且失败可回退），再重建空目录；
    /// 3. rename 失败（如跨设备/被占用）时回退为逐条删除；逐条删除仍有
    ///    失败则返回错误，不允许在脏插槽上继续恢复；
    /// 4. 目标插槽本就为空时直接成功（幂等）。
    ///
    /// 返回残留内容被移动到的 trash 目录（若有残留），供完成消息展示与
    /// 后续清理策略处置。
    pub fn clear_slot_for_restore(&self, target: Slot) -> std::io::Result<Option<PathBuf>> {
        if !target.is_test_slot() && target == self.active_slot() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("拒绝清空活跃插槽 {}：恢复必须写入非活跃插槽", target.name()),
            ));
        }

        let target_dir = self.slot_dir(target);
        if !target_dir.is_dir() || !Self::dir_has_data(&target_dir) {
            // 无残留，确保目录存在即可
            fs::create_dir_all(&target_dir)?;
            return Ok(None);
        }

        // 1. 优先整体移动到 trash 目录（保留兜底，可手动找回）
        let trash_dir = self.slots_dir().join(format!(
            "{}.trash-{}-{}",
            target.name(),
            chrono::Utc::now().format("%Y%m%d%H%M%S%6f"),
            uuid::Uuid::new_v4()
        ));
        match fs::rename(&target_dir, &trash_dir) {
            Ok(()) => {
                info!(
                    "[DataSpace] 恢复前已清空插槽 {}：残留数据移动到 {:?}",
                    target.name(),
                    trash_dir
                );
                fs::create_dir_all(&target_dir)?;
                return Ok(Some(trash_dir));
            }
            Err(e) => {
                warn!(
                    "[DataSpace] 移动插槽 {} 残留数据到 trash 失败（回退为逐条删除）: {}",
                    target.name(),
                    e
                );
            }
        }

        // 2. 回退：逐条删除插槽内容（不删除插槽目录本身）
        let mut errors: Vec<String> = Vec::new();
        for entry in fs::read_dir(&target_dir)?.filter_map(log_and_skip_entry_err) {
            let p = entry.path();
            let result = if p.is_dir() {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
            if let Err(e) = result {
                errors.push(format!("{:?}: {}", p, e));
            }
        }
        if !errors.is_empty() {
            return Err(std::io::Error::other(format!(
                "清空插槽 {} 失败（{} 个条目无法删除，禁止在脏插槽上恢复）: {}",
                target.name(),
                errors.len(),
                errors.join("; ")
            )));
        }
        info!("[DataSpace] 恢复前已清空插槽 {}（逐条删除）", target.name());
        Ok(None)
    }

    /// 标记下次重启时切换到目标 slot。
    ///
    /// 事务性保证：
    /// 1. 切换前验证目标 slot 目录存在且包含有效数据
    /// 2. 仅在验证通过后才更新 state.json 的 pending 字段
    /// 3. 实际切换在下次启动时 `initialize_on_start` 中执行
    /// 4. 如果 state.json 写入失败（如崩溃/断电），pending 不会生效，
    ///    下次启动仍使用原 active slot，保证数据安全
    pub fn mark_pending_switch(&self, target: Slot) -> std::io::Result<()> {
        // 验证目标 slot 目录存在且包含数据
        let target_dir = self.slot_dir(target);
        if !target_dir.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("目标插槽目录不存在: {}，无法切换", target_dir.display()),
            ));
        }
        if !Self::dir_has_data(&target_dir) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "目标插槽 {} 目录为空，没有可用数据，无法切换",
                    target.name()
                ),
            ));
        }

        info!("[DataSpace] 验证通过，标记下次重启切换到 {}", target.name());
        let mut st = self.read_state().unwrap_or_default();
        st.pending = Some(target.name().to_string());
        self.write_state(&st)
    }

    /// 原子登记恢复切槽及其跨进程维护租约。
    pub fn mark_restore_cutover_pending(
        &self,
        target: Slot,
        backup_id: &str,
    ) -> std::io::Result<()> {
        let target_dir = self.slot_dir(target);
        if !target_dir.is_dir() || !Self::dir_has_data(&target_dir) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("恢复目标插槽 {} 不存在或为空", target.name()),
            ));
        }
        if backup_id.trim().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "恢复维护租约缺少 backup_id",
            ));
        }

        let mut state = self.read_state()?;
        if let Some(existing) = &state.restore_cutover_pending {
            if existing.target_slot != target.name() || existing.backup_id != backup_id {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "已有恢复维护租约: backup={}, target={}",
                        existing.backup_id, existing.target_slot
                    ),
                ));
            }
        }
        state.pending = Some(target.name().to_string());
        state.restore_cutover_pending = Some(RestoreCutoverLease {
            target_slot: target.name().to_string(),
            backup_id: backup_id.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            activation_committed: false,
        });
        self.write_state(&state)
    }

    pub fn restore_cutover_pending(&self) -> std::io::Result<Option<RestoreCutoverLease>> {
        Ok(self.read_state()?.restore_cutover_pending)
    }

    /// 激活后的迁移、校验和身份轮换均完成后，先把租约推进到 committed。
    pub fn mark_restore_activation_committed(
        &self,
        active_dir: &Path,
        backup_id: &str,
    ) -> std::io::Result<()> {
        let mut state = self.read_state()?;
        let active_slot = Slot::from_name(&state.active).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "活动槽名称无效")
        })?;
        if self.slot_dir(active_slot) != active_dir {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "恢复维护租约的活动槽路径不匹配",
            ));
        }
        let lease = state.restore_cutover_pending.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "恢复维护租约不存在")
        })?;
        if lease.target_slot != state.active || lease.backup_id != backup_id {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "恢复维护租约与已激活槽不匹配",
            ));
        }
        lease.activation_committed = true;
        self.write_state(&state)
    }

    /// 仅允许新进程在恢复槽已激活且 activation committed 后解除持久租约。
    pub fn complete_restore_cutover(&self, active_dir: &Path) -> std::io::Result<bool> {
        let mut state = self.read_state()?;
        let Some(lease) = state.restore_cutover_pending.as_ref() else {
            return Ok(false);
        };
        let active_slot = Slot::from_name(&state.active).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "活动槽名称无效")
        })?;
        if lease.target_slot != state.active
            || self.slot_dir(active_slot) != active_dir
            || !lease.activation_committed
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "恢复槽尚未完成激活、迁移与校验，拒绝解除维护租约",
            ));
        }
        state.restore_cutover_pending = None;
        self.write_state(&state)?;
        Ok(true)
    }

    // ========================================================================
    // 测试插槽专用方法
    // ========================================================================

    /// 获取测试插槽 C 的目录路径
    pub fn test_slot_c_dir(&self) -> PathBuf {
        self.slot_dir(Slot::C)
    }

    /// 获取测试插槽 D 的目录路径
    pub fn test_slot_d_dir(&self) -> PathBuf {
        self.slot_dir(Slot::D)
    }

    /// 清空测试插槽（用于测试前的环境准备）
    pub fn clear_test_slots(&self) -> std::io::Result<()> {
        let slot_c = self.slot_dir(Slot::C);
        let slot_d = self.slot_dir(Slot::D);

        // 删除并重建目录
        if slot_c.exists() {
            fs::remove_dir_all(&slot_c)?;
        }
        fs::create_dir_all(&slot_c)?;

        if slot_d.exists() {
            fs::remove_dir_all(&slot_d)?;
        }
        fs::create_dir_all(&slot_d)?;

        Ok(())
    }

    /// 在测试插槽 C 中初始化测试数据
    pub fn init_test_data_in_slot_c(&self) -> std::io::Result<PathBuf> {
        let slot_c = self.slot_dir(Slot::C);
        fs::create_dir_all(&slot_c)?;
        Ok(slot_c)
    }

    /// 获取测试插槽的配对（C <-> D，类似于生产环境的 A <-> B）
    pub fn test_slot_pair(&self, slot: Slot) -> Option<Slot> {
        match slot {
            Slot::C => Some(Slot::D),
            Slot::D => Some(Slot::C),
            _ => None, // 生产插槽不返回测试配对
        }
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn copy_path_durable(source: &Path, destination: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("拒绝迁移符号链接备份条目: {}", source.display()),
        ));
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path_durable(&entry.path(), &destination.join(entry.file_name()))?;
        }
        sync_directory(destination)
    } else if metadata.is_file() {
        fs::copy(source, destination)?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)?
            .sync_all()
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("不支持的备份条目类型: {}", source.display()),
        ))
    }
}

fn paths_equal(left: &Path, right: &Path) -> std::io::Result<bool> {
    use std::io::Read;

    let left_meta = fs::symlink_metadata(left)?;
    let right_meta = fs::symlink_metadata(right)?;
    if left_meta.file_type().is_symlink() || right_meta.file_type().is_symlink() {
        return Ok(false);
    }
    if left_meta.is_file() && right_meta.is_file() {
        if left_meta.len() != right_meta.len() {
            return Ok(false);
        }
        let mut left_file = fs::File::open(left)?;
        let mut right_file = fs::File::open(right)?;
        let mut left_buffer = [0u8; 64 * 1024];
        let mut right_buffer = [0u8; 64 * 1024];
        loop {
            let left_read = left_file.read(&mut left_buffer)?;
            let right_read = right_file.read(&mut right_buffer)?;
            if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
                return Ok(false);
            }
            if left_read == 0 {
                return Ok(true);
            }
        }
    }
    if !left_meta.is_dir() || !right_meta.is_dir() {
        return Ok(false);
    }

    let mut left_names = fs::read_dir(left)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut right_names = fs::read_dir(right)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    left_names.sort();
    right_names.sort();
    if left_names != right_names {
        return Ok(false);
    }
    for name in left_names {
        if !paths_equal(&left.join(&name), &right.join(&name))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("持久化路径缺少父目录"))?;
    let payload = serde_json::to_vec_pretty(value).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("序列化持久化数据失败: {}", error),
        )
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".durable-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    temporary.write_all(&payload)?;
    temporary.as_file().sync_all()?;
    temporary
        .into_temp_path()
        .persist(path)
        .map_err(|error| error.error)?;
    sync_directory(parent)
}

static DATA_SPACE: OnceLock<DataSpaceManager> = OnceLock::new();

pub fn init_data_space_manager(base_dir: PathBuf) -> std::io::Result<()> {
    let mgr = DataSpaceManager::new(base_dir);
    mgr.initialize_on_start()?;
    DATA_SPACE.set(mgr).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "DataSpaceManager 已初始化",
        )
    })
}

pub fn get_data_space_manager() -> Option<&'static DataSpaceManager> {
    DATA_SPACE.get()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSpaceInfo {
    pub active_slot: String,
    pub inactive_slot: String,
    pub pending_slot: Option<String>,
    pub active_dir: String,
    pub inactive_dir: String,
}

/// Slot 目录完整性报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotIntegrityReport {
    /// 插槽名称
    pub slot: String,
    /// 插槽目录路径
    pub dir_path: String,
    /// 目录是否存在
    pub exists: bool,
    /// 是否包含数据
    pub has_data: bool,
    /// 是否包含数据库文件
    pub has_database: bool,
    /// 发现的数据库文件列表
    pub database_files: Vec<String>,
    /// 子目录列表
    pub subdirectories: Vec<String>,
    /// 总大小（字节）
    pub total_size_bytes: u64,
    /// 文件数量（不含子目录内文件的递归统计）
    pub file_count: usize,
    /// 检出的问题列表
    pub issues: Vec<String>,
}

impl SlotIntegrityReport {
    /// 判断 slot 是否完整可用（无问题）
    pub fn is_healthy(&self) -> bool {
        self.issues.is_empty()
    }

    /// 格式化为人类可读的摘要
    pub fn summary(&self) -> String {
        if self.is_healthy() {
            format!(
                "插槽 {} 完整: {} 个数据库文件, {} 个子目录, {:.2} MB",
                self.slot,
                self.database_files.len(),
                self.subdirectories.len(),
                self.total_size_bytes as f64 / 1024.0 / 1024.0
            )
        } else {
            format!("插槽 {} 异常: {}", self.slot, self.issues.join("; "))
        }
    }
}

#[tauri::command]
pub fn get_startup_recovery_status(
    state: tauri::State<'_, StartupRecoveryState>,
) -> Result<StartupRecoveryStatus, AppError> {
    state
        .status()
        .map_err(|error| AppError::internal(format!("读取启动恢复状态失败: {error}")))
}

#[tauri::command]
pub fn retry_startup_recovery_preflight(
    state: tauri::State<'_, StartupRecoveryState>,
) -> Result<StartupRecoveryStatus, AppError> {
    Ok(state.retry_preflight())
}

#[tauri::command]
pub fn open_startup_recovery_incident_folder(
    state: tauri::State<'_, StartupRecoveryState>,
    incident_id: String,
) -> Result<(), AppError> {
    let directory = state
        .incident_directory(&incident_id)
        .map_err(|error| AppError::file_system(format!("定位恢复事件目录失败: {error}")))?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    command
        .arg(&directory)
        .spawn()
        .map_err(|error| AppError::file_system(format!("打开恢复事件目录失败: {error}")))?;

    #[cfg(any(target_os = "android", target_os = "ios"))]
    return Err(AppError::validation(
        "移动端不支持直接打开恢复事件目录".to_string(),
    ));

    Ok(())
}

#[tauri::command]
pub async fn export_startup_recovery_incident(
    state: tauri::State<'_, StartupRecoveryState>,
    incident_id: String,
    destination: String,
) -> Result<String, AppError> {
    let source = state
        .incident_directory(&incident_id)
        .map_err(|error| AppError::file_system(format!("定位恢复事件目录失败: {error}")))?;
    let destination = PathBuf::from(destination);
    let export_destination = destination.clone();
    tauri::async_runtime::spawn_blocking(move || export_incident_zip(&source, &export_destination))
        .await
        .map_err(|error| AppError::internal(format!("恢复事件导出任务异常: {error}")))?
        .map_err(|error| AppError::file_system(format!("导出恢复事件失败: {error}")))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_startup_recovery_report(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupRecoveryState>,
    destination: String,
) -> Result<String, AppError> {
    let component_health = {
        #[cfg(feature = "data_governance")]
        {
            app.try_state::<crate::data_governance::StartupComponentHealthState>()
                .map(|health| health.snapshot())
        }
        #[cfg(not(feature = "data_governance"))]
        {
            Option::<serde_json::Value>::None
        }
    };
    let payload = serde_json::json!({
        "format_version": 1,
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "startup_recovery": state.status()
            .map_err(|error| AppError::internal(format!("读取恢复状态失败: {error}")))?,
        "incidents": state.incidents().unwrap_or_default(),
        "component_health": component_health,
    });
    let destination = PathBuf::from(destination);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::file_system(format!("创建诊断报告目录失败: {error}")))?;
    }
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| AppError::internal(format!("生成诊断报告失败: {error}")))?;
    fs::write(&destination, bytes)
        .map_err(|error| AppError::file_system(format!("写入诊断报告失败: {error}")))?;
    Ok(destination.to_string_lossy().to_string())
}

fn export_incident_zip(source: &Path, destination: &Path) -> std::io::Result<()> {
    use walkdir::WalkDir;
    use zip::write::FileOptions;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = destination.with_extension("zip.partial");
    let backup = destination.with_extension("zip.previous");
    if partial.exists() {
        fs::remove_file(&partial)?;
    }
    let file = fs::File::create(&partial)?;
    let mut archive = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let write_result = (|| -> std::io::Result<()> {
        for entry in WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(std::io::Error::other)?;
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(std::io::Error::other)?;
            if relative.as_os_str().is_empty() {
                continue;
            }
            let name = relative.to_string_lossy().replace('\\', "/");
            let file_type = entry.file_type();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                archive.add_directory(format!("{name}/"), options)?;
                continue;
            }
            if file_type.is_file() {
                archive.start_file(name, options)?;
                let mut input = fs::File::open(entry.path())?;
                std::io::copy(&mut input, &mut archive)?;
            }
        }
        let output = archive.finish()?;
        output.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }

    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(&partial, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(error);
    }
    if backup.exists() {
        fs::remove_file(backup)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_startup_recovery_incidents(
    state: tauri::State<'_, StartupRecoveryState>,
) -> Result<Vec<StartupRecoveryIncident>, AppError> {
    state
        .incidents()
        .map_err(|error| AppError::file_system(format!("读取启动恢复记录失败: {error}")))
}

#[tauri::command]
pub fn resolve_startup_recovery(
    state: tauri::State<'_, StartupRecoveryState>,
    candidate_id: String,
) -> Result<StartupRecoveryResolveResponse, AppError> {
    if !matches!(candidate_id.as_str(), "legacy" | "slotA" | "slotB") {
        return Err(AppError::validation(
            "候选 id 必须是 legacy、slotA 或 slotB".to_string(),
        ));
    }
    state
        .resolve(&candidate_id)
        .map_err(|error| AppError::file_system(format!("解决启动恢复事件失败: {error}")))
}

#[tauri::command]
pub fn get_data_space_info() -> Result<DataSpaceInfo, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
    // 读取 state 以获取 pending
    let st: SlotState = mgr
        .read_state()
        .map_err(|e| AppError::internal(format!("读取数据空间状态失败: {}", e)))?;
    let active_slot = if st.active == "slotB" {
        "slotB"
    } else {
        "slotA"
    }
    .to_string();
    let inactive_slot = if active_slot == "slotA" {
        "slotB"
    } else {
        "slotA"
    }
    .to_string();
    let info = DataSpaceInfo {
        active_slot: active_slot.clone(),
        inactive_slot: inactive_slot.clone(),
        pending_slot: st.pending.clone(),
        active_dir: mgr.active_dir().to_string_lossy().to_string(),
        inactive_dir: mgr.inactive_dir().to_string_lossy().to_string(),
    };
    Ok(info)
}

#[tauri::command]
pub fn mark_data_space_pending_switch_to_inactive() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
    let target = mgr.inactive_slot();
    mgr.mark_pending_switch(target)
        .map_err(|e| AppError::file_system(format!("标记切换失败: {}", e)))?;
    Ok(format!("已标记下次重启切换到 {}", target.name()))
}

/// ★ F13：清空全部数据（桌面）。
///
/// 不在进程内删库——Windows 下活动数据库文件被占用，无法可靠删除；改为写入“下次启动
/// 清理”标记，前端随后触发 `restart_app`。重启后 `lib.rs` setup 在**打开任何数据库之前**
/// 调用 `purge_active_data_dir` 完成物理删除并清除标记（删除失败会保留标记下次重试）。
/// 保留 `backups`/`temp_restore`/`migration_core_backups`，备份是数据恢复路径。
#[tauri::command]
pub fn purge_all_database_files() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
    crate::startup_cleanup::write_purge_marker(mgr.base_dir())?;
    Ok("已标记：下次启动将清空所有数据（备份保留），即将重启应用以完成清空。".to_string())
}

/// 旧版移动端即时清理入口。
///
/// WebView reload 不会重建 Rust 进程中的 SQLite 连接池；直接 unlink 活动数据库后，
/// 旧连接仍可能继续读写已删除 inode。该路径因此 fail-close，统一要求通过
/// `purge_all_database_files` 写 marker 后完整重启进程。
#[tauri::command]
pub fn purge_active_data_dir_now() -> Result<String, AppError> {
    Err(AppError::validation(
        "为保证数据库连接安全，移动端清空数据需要完整退出并重新打开应用，不能仅刷新页面"
            .to_string(),
    ))
}

// ============================================================================
// 测试插槽专用命令
// ============================================================================

/// 测试插槽信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestSlotInfo {
    pub slot_c_dir: String,
    pub slot_d_dir: String,
    pub slot_c_exists: bool,
    pub slot_d_exists: bool,
    pub slot_c_file_count: usize,
    pub slot_d_file_count: usize,
}

/// 获取测试插槽信息
#[tauri::command]
pub fn get_test_slot_info() -> Result<TestSlotInfo, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot_c = mgr.test_slot_c_dir();
    let slot_d = mgr.test_slot_d_dir();

    let count_files =
        |path: &PathBuf| -> usize { fs::read_dir(path).map(|it| it.count()).unwrap_or(0) };

    Ok(TestSlotInfo {
        slot_c_dir: slot_c.to_string_lossy().to_string(),
        slot_d_dir: slot_d.to_string_lossy().to_string(),
        slot_c_exists: slot_c.exists(),
        slot_d_exists: slot_d.exists(),
        slot_c_file_count: count_files(&slot_c),
        slot_d_file_count: count_files(&slot_d),
    })
}

/// 清空测试插槽（测试前准备）
#[tauri::command]
pub fn clear_test_slots() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    mgr.clear_test_slots()
        .map_err(|e| AppError::file_system(format!("清空测试插槽失败: {}", e)))?;

    Ok("测试插槽 C 和 D 已清空".to_string())
}

/// 重启应用
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// 获取指定插槽的目录路径
#[tauri::command]
pub fn get_slot_directory(slot_name: String) -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot = Slot::from_name(&slot_name)
        .ok_or_else(|| AppError::validation(format!("无效的插槽名称: {}", slot_name)))?;

    Ok(mgr.slot_dir(slot).to_string_lossy().to_string())
}

// ============================================================================
// 完整性检查（SlotManager 方法保留，供测试与潜在内部调用；
// get_slot_size / verify_slot_integrity / verify_all_slots_integrity /
// check_switch_disk_space 四个 #[tauri::command] 已于 2026-06-13 删除——
// 它们未在 generate_handler! 注册且前端零调用，属僵尸命令）
// ============================================================================

// ============================================================================
// 单元 / 集成测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// 创建一个隔离的 DataSpaceManager，使用临时目录
    fn make_manager() -> (TempDir, DataSpaceManager) {
        let tmp = TempDir::new().expect("创建临时目录失败");
        let mgr = DataSpaceManager::new(tmp.path().to_path_buf());
        (tmp, mgr)
    }

    /// 辅助：在指定 slot 目录下放入一个占位文件，使其 "非空"
    fn populate_slot(mgr: &DataSpaceManager, slot: Slot) {
        let dir = mgr.slot_dir(slot);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("placeholder.txt"), "data").unwrap();
    }

    /// 辅助：在指定 slot 目录下放入一个 .db 文件，使完整性检查通过
    fn populate_slot_with_db(mgr: &DataSpaceManager, slot: Slot) {
        let dir = mgr.slot_dir(slot);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.db"), "sqlite-fake-content").unwrap();
    }

    fn create_recovery_db(path: &Path, marker: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let connection = rusqlite::Connection::open(path).unwrap();
        connection
            .execute("CREATE TABLE recovery_marker (value TEXT NOT NULL)", [])
            .unwrap();
        connection
            .execute("INSERT INTO recovery_marker (value) VALUES (?1)", [marker])
            .unwrap();
    }

    fn read_recovery_marker(path: &Path) -> String {
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .query_row("SELECT value FROM recovery_marker LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    // -----------------------------------------------------------------------
    // 1. ensure_layout — 创建所有必要目录
    // -----------------------------------------------------------------------
    #[test]
    fn test_ensure_layout_creates_directories() {
        let (_tmp, mgr) = make_manager();

        mgr.ensure_layout().expect("ensure_layout 应成功");

        // 验证四个 slot 目录均已创建
        assert!(mgr.slot_dir(Slot::A).is_dir(), "slotA 目录应存在");
        assert!(mgr.slot_dir(Slot::B).is_dir(), "slotB 目录应存在");
        assert!(mgr.slot_dir(Slot::C).is_dir(), "slotC 目录应存在");
        assert!(mgr.slot_dir(Slot::D).is_dir(), "slotD 目录应存在");

        // 验证 state.json 已创建
        assert!(mgr.state_path().exists(), "state.json 应已创建");
    }

    // -----------------------------------------------------------------------
    // 2. read_state / write_state — 读写往返一致
    // -----------------------------------------------------------------------
    #[test]
    fn test_read_write_state_roundtrip() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 写入自定义状态
        let state = SlotState {
            active: "slotB".to_string(),
            pending: Some("slotA".to_string()),
            ..SlotState::default()
        };
        mgr.write_state(&state).expect("write_state 应成功");

        // 读取并验证
        let read_back = mgr.read_state().expect("read_state 应成功");
        assert_eq!(read_back.active, "slotB");
        assert_eq!(read_back.pending, Some("slotA".to_string()));
    }

    // -----------------------------------------------------------------------
    // 3. 原子写入 — state.json 内容正确
    // -----------------------------------------------------------------------
    #[test]
    fn test_atomic_write_state_file_content() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        let state = SlotState {
            active: "slotA".to_string(),
            pending: None,
            ..SlotState::default()
        };
        mgr.write_state(&state).unwrap();

        // 直接读取文件验证 JSON 内容
        let raw = fs::read_to_string(mgr.state_path()).expect("应能读取 state.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("state.json 应为有效 JSON");
        assert_eq!(parsed["active"], "slotA");
        assert!(parsed["pending"].is_null());

        // 原子写入后 .tmp 文件不应存在（rename 将其替换为正式文件）
        let tmp_path = mgr.slots_dir().join("state.json.tmp");
        assert!(!tmp_path.exists(), "原子写入后 .tmp 文件不应残留");
    }

    // -----------------------------------------------------------------------
    // 4. 损坏恢复 — 主文件损坏，从 .tmp 恢复
    // -----------------------------------------------------------------------
    #[test]
    fn test_corruption_recovery_from_tmp() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 先写一份正确状态到 .tmp 文件（模拟原子写入的中间态）
        let tmp_path = mgr.slots_dir().join("state.json.tmp");
        let valid_state = SlotState {
            active: "slotB".to_string(),
            pending: None,
            ..SlotState::default()
        };
        let valid_json = serde_json::to_string_pretty(&valid_state).unwrap();
        fs::write(&tmp_path, &valid_json).unwrap();

        // 破坏 state.json（写入无效 JSON）
        fs::write(mgr.state_path(), "THIS IS NOT JSON!!!").unwrap();

        // read_state 应从 .tmp 恢复
        let recovered = mgr.read_state().expect("应能从 .tmp 恢复");
        assert_eq!(recovered.active, "slotB", "应恢复到 slotB");
    }

    // -----------------------------------------------------------------------
    // 5. 损坏恢复 — 目录推断（两个文件都不存在）
    // -----------------------------------------------------------------------
    #[test]
    fn test_corruption_recovery_infer_from_dirs() {
        let (_tmp, mgr) = make_manager();

        // 只创建 slots 目录和 slotB（不创建 state.json）
        fs::create_dir_all(mgr.slot_dir(Slot::A)).unwrap();
        let slot_b = mgr.slot_dir(Slot::B);
        fs::create_dir_all(&slot_b).unwrap();
        // 仅在 slotB 放入数据
        fs::write(slot_b.join("data.db"), "content").unwrap();

        // 此时 state.json 和 .tmp 均不存在
        assert!(!mgr.state_path().exists());

        // read_state 应通过目录推断
        let inferred = mgr.read_state().expect("应能通过目录推断");
        assert_eq!(inferred.active, "slotB", "仅 slotB 有数据时应推断为活跃");
    }

    // -----------------------------------------------------------------------
    // 6. mark_pending_switch — 正确写入 pending 状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_mark_pending_switch() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 在 slotB 放入数据（mark_pending_switch 要求目标非空）
        populate_slot(&mgr, Slot::B);

        mgr.mark_pending_switch(Slot::B)
            .expect("mark_pending_switch 应成功");

        let st = mgr.read_state().unwrap();
        assert_eq!(
            st.pending,
            Some("slotB".to_string()),
            "pending 应被标记为 slotB"
        );
    }

    // -----------------------------------------------------------------------
    // 6b. mark_pending_switch — 目标为空时应失败
    // -----------------------------------------------------------------------
    #[test]
    fn test_mark_pending_switch_empty_target_fails() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 为空，mark_pending_switch 应失败
        let result = mgr.mark_pending_switch(Slot::B);
        assert!(result.is_err(), "目标 slot 为空时应返回错误");
    }

    // -----------------------------------------------------------------------
    // 7. initialize_on_start — 有效 pending：pending 指向有效 slot，成功切换
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_valid_pending() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 在 slotB 放入数据
        populate_slot(&mgr, Slot::B);

        // 手动写入 pending = slotB
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotB".to_string()),
            ..SlotState::default()
        };
        mgr.write_state(&state).unwrap();

        // 模拟启动
        mgr.initialize_on_start();

        // 验证切换成功
        let after = mgr.read_state().unwrap();
        assert_eq!(after.active, "slotB", "应已切换到 slotB");
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 8. initialize_on_start — 无效 pending：pending 指向无效 slot，保持原状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_invalid_pending() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 写入 pending 指向一个完全无效的名称
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotZ_nonexistent".to_string()),
            ..SlotState::default()
        };
        mgr.write_state(&state).unwrap();

        mgr.initialize_on_start();

        // 应保持 slotA
        let after = mgr.read_state().unwrap();
        assert_eq!(after.active, "slotA", "无效 pending 时应保持原 active");
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 8b. initialize_on_start — pending 指向空目录，保持原状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_pending_empty_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 目录存在但为空
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotB".to_string()),
            ..SlotState::default()
        };
        mgr.write_state(&state).unwrap();

        mgr.initialize_on_start();

        // slotB 为空，不应切换
        let after = mgr.read_state().unwrap();
        assert_eq!(
            after.active, "slotA",
            "pending 指向空 slot 时应保持原 active"
        );
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 9. verify_slot_integrity — 有数据的 slot 报告健康
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_healthy() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 放入数据库文件和子目录
        populate_slot_with_db(&mgr, Slot::A);
        let subdir = mgr.slot_dir(Slot::A).join("images");
        fs::create_dir_all(&subdir).unwrap();
        fs::write(subdir.join("photo.jpg"), "fake-image-bytes").unwrap();

        let report = mgr.verify_slot_integrity(Slot::A);

        assert!(report.exists, "目录应存在");
        assert!(report.has_data, "应有数据");
        assert!(report.has_database, "应检测到数据库文件");
        assert!(
            report.database_files.contains(&"main.db".to_string()),
            "应包含 main.db"
        );
        assert!(
            report.subdirectories.contains(&"images".to_string()),
            "应包含 images 子目录"
        );
        assert!(report.is_healthy(), "报告应为健康状态");
        assert!(report.total_size_bytes > 0, "总大小应 > 0");
    }

    // -----------------------------------------------------------------------
    // 10. verify_slot_integrity — 空 slot 报告问题
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_empty_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 在 ensure_layout 后为空
        let report = mgr.verify_slot_integrity(Slot::B);

        assert!(report.exists, "目录应存在");
        assert!(!report.has_data, "不应有数据");
        assert!(!report.is_healthy(), "空 slot 应不健康");
        assert!(
            report.issues.iter().any(|i| i.contains("为空")),
            "issues 应包含空目录相关信息"
        );
    }

    // -----------------------------------------------------------------------
    // 10b. verify_slot_integrity — 目录不存在
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_missing_dir() {
        let (tmp, _) = make_manager();
        // 创建一个新 manager 指向不存在的子目录
        let mgr = DataSpaceManager::new(tmp.path().join("nonexistent_base"));

        let report = mgr.verify_slot_integrity(Slot::A);

        assert!(!report.exists, "目录不应存在");
        assert!(!report.is_healthy(), "不存在的 slot 应不健康");
        assert!(
            report.issues.iter().any(|i| i.contains("不存在")),
            "issues 应包含不存在相关信息"
        );
    }

    // -----------------------------------------------------------------------
    // 11. SlotIntegrityReport.is_healthy — 有问题时返回 false
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_integrity_report_is_healthy() {
        // 无 issues → healthy
        let healthy_report = SlotIntegrityReport {
            slot: "slotA".to_string(),
            dir_path: "/tmp/test".to_string(),
            exists: true,
            has_data: true,
            has_database: true,
            database_files: vec!["main.db".to_string()],
            subdirectories: vec![],
            total_size_bytes: 1024,
            file_count: 1,
            issues: vec![],
        };
        assert!(healthy_report.is_healthy());

        // 有 issues → not healthy
        let unhealthy_report = SlotIntegrityReport {
            slot: "slotB".to_string(),
            dir_path: "/tmp/test".to_string(),
            exists: true,
            has_data: true,
            has_database: false,
            database_files: vec![],
            subdirectories: vec![],
            total_size_bytes: 100,
            file_count: 1,
            issues: vec!["未找到数据库文件".to_string()],
        };
        assert!(!unhealthy_report.is_healthy());
    }

    // -----------------------------------------------------------------------
    // 12. slot_size — 计算正确
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_size_calculation() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 空 slot 大小应为 0
        let empty_size = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(empty_size, 0, "空 slot 大小应为 0");

        // 写入已知大小的文件
        let content = b"hello world 1234567890"; // 22 bytes
        fs::write(mgr.slot_dir(Slot::A).join("file1.txt"), content).unwrap();

        let size_after = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(size_after, 22, "应精确计算单文件大小");

        // 创建子目录并写入更多文件
        let subdir = mgr.slot_dir(Slot::A).join("nested");
        fs::create_dir_all(&subdir).unwrap();
        let content2 = b"abcdefgh"; // 8 bytes
        fs::write(subdir.join("file2.txt"), content2).unwrap();

        let total = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(total, 30, "应递归计算总大小 (22 + 8 = 30)");
    }

    // -----------------------------------------------------------------------
    // 补充: Slot 基础方法测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_basic_methods() {
        // name()
        assert_eq!(Slot::A.name(), "slotA");
        assert_eq!(Slot::B.name(), "slotB");
        assert_eq!(Slot::C.name(), "slotC");
        assert_eq!(Slot::D.name(), "slotD");

        // from_name()
        assert_eq!(Slot::from_name("slotA"), Some(Slot::A));
        assert_eq!(Slot::from_name("A"), Some(Slot::A));
        assert_eq!(Slot::from_name("slotB"), Some(Slot::B));
        assert_eq!(Slot::from_name("B"), Some(Slot::B));
        assert_eq!(Slot::from_name("C"), Some(Slot::C));
        assert_eq!(Slot::from_name("D"), Some(Slot::D));
        assert_eq!(Slot::from_name("invalid"), None);

        // is_test_slot()
        assert!(!Slot::A.is_test_slot());
        assert!(!Slot::B.is_test_slot());
        assert!(Slot::C.is_test_slot());
        assert!(Slot::D.is_test_slot());
    }

    // -----------------------------------------------------------------------
    // 补充: ensure_layout 幂等性测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_ensure_layout_idempotent() {
        let (_tmp, mgr) = make_manager();

        mgr.ensure_layout().unwrap();
        let first_state = fs::read_to_string(mgr.state_path()).unwrap();

        // 再次调用不应出错，state.json 内容不变
        mgr.ensure_layout().unwrap();
        let second_state = fs::read_to_string(mgr.state_path()).unwrap();

        assert_eq!(
            first_state, second_state,
            "重复 ensure_layout 不应改变 state.json"
        );
    }

    // -----------------------------------------------------------------------
    // 补充: active_slot / inactive_slot 测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_active_inactive_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 默认应为 slotA
        assert_eq!(mgr.active_slot(), Slot::A);
        assert_eq!(mgr.inactive_slot(), Slot::B);

        // 切换到 slotB
        let state = SlotState {
            active: "slotB".to_string(),
            pending: None,
            ..SlotState::default()
        };
        mgr.write_state(&state).unwrap();
        assert_eq!(mgr.active_slot(), Slot::B);
        assert_eq!(mgr.inactive_slot(), Slot::A);
    }

    // -----------------------------------------------------------------------
    // 补充: clear_slot_for_restore 测试（审阅 15 P1-2）
    // -----------------------------------------------------------------------
    #[test]
    fn test_clear_slot_for_restore_moves_residual_to_trash() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 活跃为 slotA，向非活跃 slotB 放入残留数据
        populate_slot_with_db(&mgr, Slot::B);
        let residual_sub = mgr.slot_dir(Slot::B).join("images");
        fs::create_dir_all(&residual_sub).unwrap();
        fs::write(residual_sub.join("old.jpg"), "stale").unwrap();

        let trash = mgr
            .clear_slot_for_restore(Slot::B)
            .expect("清空非活跃插槽应成功");

        // 插槽应存在且为空
        let slot_b = mgr.slot_dir(Slot::B);
        assert!(slot_b.is_dir(), "清空后插槽目录应仍存在");
        assert!(
            fs::read_dir(&slot_b).unwrap().next().is_none(),
            "清空后插槽应为空"
        );

        // 残留数据应被移动到 trash 目录
        let trash = trash.expect("有残留时应返回 trash 目录");
        assert!(trash.is_dir(), "trash 目录应存在");
        assert!(
            trash.join("main.db").exists(),
            "残留数据库应保留在 trash 中"
        );
        assert!(
            trash.join("images").join("old.jpg").exists(),
            "残留资产应保留在 trash 中"
        );
    }

    #[test]
    fn test_clear_slot_for_restore_rejects_active_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 默认活跃 slotA
        populate_slot(&mgr, Slot::A);
        let result = mgr.clear_slot_for_restore(Slot::A);
        assert!(result.is_err(), "清空活跃插槽应被拒绝");
        assert!(
            mgr.slot_dir(Slot::A).join("placeholder.txt").exists(),
            "活跃插槽数据不应被动过"
        );
    }

    #[test]
    fn test_clear_slot_for_restore_empty_slot_is_noop() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        let trash = mgr
            .clear_slot_for_restore(Slot::B)
            .expect("空插槽清空应成功");
        assert!(trash.is_none(), "空插槽不应产生 trash 目录");
        assert!(mgr.slot_dir(Slot::B).is_dir(), "插槽目录应仍存在");
    }

    #[test]
    fn restore_cutover_lease_survives_restart_until_activation_commit() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();
        populate_slot_with_db(&mgr, Slot::B);

        mgr.mark_restore_cutover_pending(Slot::B, "backup-1")
            .unwrap();
        let before = mgr.restore_cutover_pending().unwrap().unwrap();
        assert_eq!(before.target_slot, "slotB");
        assert!(!before.activation_committed);

        mgr.initialize_on_start().unwrap();
        assert_eq!(mgr.active_slot(), Slot::B);
        assert!(
            mgr.complete_restore_cutover(&mgr.active_dir()).is_err(),
            "迁移校验提交前不得解除维护租约"
        );

        mgr.mark_restore_activation_committed(&mgr.active_dir(), "backup-1")
            .unwrap();
        assert!(mgr.complete_restore_cutover(&mgr.active_dir()).unwrap());
        assert!(mgr.restore_cutover_pending().unwrap().is_none());
    }

    #[test]
    fn legacy_slot_backups_are_durably_migrated_and_idempotent() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();
        let source = mgr.slot_dir(Slot::A).join("backups").join("backup-1");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("manifest.json"),
            b"{\"backup_id\":\"backup-1\"}",
        )
        .unwrap();

        mgr.migrate_legacy_slot_backups().unwrap();
        let destination = mgr.recovery_backups_dir().join("backup-1");
        assert!(destination.join("manifest.json").is_file());
        assert!(!source.exists());

        mgr.migrate_legacy_slot_backups().unwrap();
        assert!(destination.join("manifest.json").is_file());
    }

    // -----------------------------------------------------------------------
    // 补充: summary() 方法测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_integrity_report_summary() {
        let healthy = SlotIntegrityReport {
            slot: "slotA".to_string(),
            dir_path: "/test".to_string(),
            exists: true,
            has_data: true,
            has_database: true,
            database_files: vec!["main.db".to_string()],
            subdirectories: vec!["images".to_string()],
            total_size_bytes: 2 * 1024 * 1024, // 2 MB
            file_count: 1,
            issues: vec![],
        };
        let summary = healthy.summary();
        assert!(summary.contains("完整"), "健康报告应包含 '完整'");
        assert!(summary.contains("1 个数据库文件"), "应显示数据库文件数");

        let unhealthy = SlotIntegrityReport {
            slot: "slotB".to_string(),
            dir_path: "/test".to_string(),
            exists: false,
            has_data: false,
            has_database: false,
            database_files: vec![],
            subdirectories: vec![],
            total_size_bytes: 0,
            file_count: 0,
            issues: vec!["插槽目录不存在".to_string()],
        };
        let summary = unhealthy.summary();
        assert!(summary.contains("异常"), "异常报告应包含 '异常'");
        assert!(summary.contains("不存在"), "应显示具体问题");
    }

    #[test]
    fn startup_recovery_detects_conflict_and_quarantines_legacy_root() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        create_recovery_db(&manager.slot_dir(Slot::B).join("chat_v2.db"), "slot-b");
        create_recovery_db(&tmp.path().join("mistakes.db"), "legacy");

        let incident = prepare_startup_recovery(tmp.path())
            .unwrap()
            .expect("冲突应建立恢复事件");
        let incident_dir = startup_incident_dir(tmp.path(), &incident.incident_id);

        assert!(!tmp.path().join("mistakes.db").exists());
        assert_eq!(
            read_recovery_marker(&incident_dir.join("legacy-root").join("mistakes.db")),
            "legacy"
        );
        let legacy = incident
            .candidates
            .iter()
            .find(|candidate| candidate.id == "legacy")
            .unwrap();
        assert!(legacy.has_data);
        assert!(legacy.has_database);
        assert!(legacy.selectable);
        assert_eq!(legacy.core_database_filenames, vec!["mistakes.db"]);
        assert_eq!(legacy.valid_core_database_filenames, vec!["mistakes.db"]);
        assert!(incident_dir.join(STARTUP_RECOVERY_MANIFEST_FILE).is_file());
        assert!(incident_dir.join(STARTUP_RECOVERY_JOURNAL_FILE).is_file());
    }

    #[test]
    fn startup_recovery_can_select_existing_slot_without_merging_legacy() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        create_recovery_db(&manager.slot_dir(Slot::B).join("chat_v2.db"), "slot-b");
        create_recovery_db(&tmp.path().join("mistakes.db"), "legacy");

        let incident = prepare_startup_recovery(tmp.path()).unwrap().unwrap();
        let incident_id = incident.incident_id.clone();
        let state = StartupRecoveryState::new(tmp.path().to_path_buf(), Some(incident));
        let response = state.resolve("slotB").unwrap();

        assert!(response.resolved);
        assert!(response.restart_required);
        assert_eq!(response.selected_candidate, "slotB");
        let selected_state: SlotState =
            read_json_file(&manager.state_path(), "测试插槽状态").unwrap();
        assert_eq!(selected_state.active, "slotB");
        assert!(selected_state.pending.is_none());
        assert!(selected_state.restore_cutover_pending.is_none());
        assert!(manager.legacy_migration_complete_path().is_file());
        assert!(
            startup_incident_dir(tmp.path(), &incident_id)
                .join("legacy-root")
                .join("mistakes.db")
                .is_file(),
            "选择插槽后隔离的旧时间线必须保留"
        );
        let history = state.incidents().unwrap();
        assert_eq!(history.len(), 1);
        assert!(history[0].resolved);
        assert_eq!(history[0].selected_candidate.as_deref(), Some("slotB"));
    }

    #[test]
    fn startup_recovery_can_restore_legacy_and_archive_slot_a() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        create_recovery_db(
            &manager.slot_dir(Slot::A).join("llm_usage.db"),
            "slot-a-old",
        );
        create_recovery_db(&manager.slot_dir(Slot::B).join("chat_v2.db"), "slot-b");
        create_recovery_db(&tmp.path().join("mistakes.db"), "legacy-selected");

        let incident = prepare_startup_recovery(tmp.path()).unwrap().unwrap();
        let incident_id = incident.incident_id.clone();
        let state = StartupRecoveryState::new(tmp.path().to_path_buf(), Some(incident));
        state.resolve("legacy").unwrap();

        assert_eq!(
            read_recovery_marker(&manager.slot_dir(Slot::A).join("mistakes.db")),
            "legacy-selected"
        );
        assert_eq!(
            read_recovery_marker(
                &startup_incident_dir(tmp.path(), &incident_id)
                    .join(STARTUP_RECOVERY_SLOT_A_ARCHIVE)
                    .join("llm_usage.db")
            ),
            "slot-a-old"
        );
        assert_eq!(
            read_recovery_marker(&manager.slot_dir(Slot::B).join("chat_v2.db")),
            "slot-b",
            "legacy 恢复不得改动 slotB"
        );
        assert_eq!(manager.read_state().unwrap().active, "slotA");
    }

    #[test]
    fn startup_recovery_reinspection_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        create_recovery_db(&manager.slot_dir(Slot::B).join("chat_v2.db"), "slot-b");
        create_recovery_db(&tmp.path().join("mistakes.db"), "legacy");

        let first = prepare_startup_recovery(tmp.path()).unwrap().unwrap();
        let second = prepare_startup_recovery(tmp.path()).unwrap().unwrap();

        assert_eq!(first.incident_id, second.incident_id);
        assert_eq!(
            read_recovery_marker(
                &startup_incident_dir(tmp.path(), &second.incident_id)
                    .join("legacy-root")
                    .join("mistakes.db")
            ),
            "legacy"
        );
        assert!(!tmp.path().join("mistakes.db").exists());

        let mut interrupted_resolution = second;
        interrupted_resolution.selected_candidate = Some("slotB".to_string());
        atomic_write_json(
            &startup_incident_dir(tmp.path(), &interrupted_resolution.incident_id)
                .join(STARTUP_RECOVERY_MANIFEST_FILE),
            &interrupted_resolution,
        )
        .unwrap();
        assert!(
            prepare_startup_recovery(tmp.path()).unwrap().is_none(),
            "已持久化的选择应在重启检查时自动完成"
        );
        assert_eq!(manager.read_state().unwrap().active, "slotB");
    }

    #[test]
    fn startup_recovery_rejects_candidates_without_known_core_databases() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        fs::write(manager.slot_dir(Slot::B).join("cache.db"), b"not-core").unwrap();
        fs::write(tmp.path().join("unrelated.db"), b"not-core").unwrap();

        let incident = prepare_startup_recovery(tmp.path()).unwrap().unwrap();
        assert!(incident
            .candidates
            .iter()
            .all(|candidate| !candidate.selectable));
        let state = StartupRecoveryState::new(tmp.path().to_path_buf(), Some(incident));
        let error = state.resolve("slotB").unwrap_err();
        assert!(error.to_string().contains("核心数据库"));
        assert!(state
            .status()
            .unwrap()
            .incident
            .unwrap()
            .recovery_error
            .is_some());
    }

    #[test]
    fn startup_recovery_resolution_error_remains_visible_and_retryable() {
        let tmp = TempDir::new().unwrap();
        let manager = DataSpaceManager::new(tmp.path().to_path_buf());
        fs::create_dir_all(manager.slot_dir(Slot::A)).unwrap();
        fs::create_dir_all(manager.slot_dir(Slot::B)).unwrap();
        let selected = manager.slot_dir(Slot::B).join("chat_v2.db");
        fs::write(&selected, b"slot-b").unwrap();
        create_recovery_db(&tmp.path().join("mistakes.db"), "legacy");

        let incident = prepare_startup_recovery(tmp.path()).unwrap().unwrap();
        fs::remove_file(selected).unwrap();
        let state = StartupRecoveryState::new(tmp.path().to_path_buf(), Some(incident));
        assert!(state.resolve("slotB").is_err());

        let status = state.status().unwrap();
        let incident = status.incident.unwrap();
        assert!(status.recovery_required);
        assert_eq!(
            incident.failed_operation.as_deref(),
            Some("resolve_selection")
        );
        assert!(incident.recovery_error.is_some());
    }

    #[test]
    fn startup_recovery_can_expose_an_ephemeral_preflight_failure() {
        let tmp = TempDir::new().unwrap();
        let state = StartupRecoveryState::failed(
            tmp.path().to_path_buf(),
            "startup_preflight",
            "synthetic failure",
        );
        let status = state.status().unwrap();
        assert!(status.recovery_required);
        let incident = status.incident.unwrap();
        assert_eq!(
            incident.failed_operation.as_deref(),
            Some("startup_preflight")
        );
        assert_eq!(
            incident.recovery_error.as_deref(),
            Some("synthetic failure")
        );
    }
}
