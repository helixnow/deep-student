use std::collections::BTreeSet;
use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::{
    configure_stdio, platform_sandbox_contract, PlatformSandboxBackend, SandboxBackend,
    SandboxCapability, SandboxEffectReport, SandboxPolicy, UnsandboxedShellBackend,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, BOOL, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_ABANDONED_0, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, AddAccessDeniedAceEx, AddAce, DeriveCapabilitySidsFromName, EqualSid,
    FreeSid, GetAce, GetLengthSid, GetSecurityDescriptorControl, InitializeAcl, ACCESS_DENIED_ACE,
    ACE_HEADER, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSID, SECURITY_CAPABILITIES, SE_DACL_PROTECTED, SID_AND_ATTRIBUTES,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, OpenJobObjectW,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_TIME,
};
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_TERMINATE, SE_GROUP_ENABLED};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcessId,
    GetExitCodeProcess, InitializeProcThreadAttributeList, OpenEventW, ReleaseMutex, ResumeThread,
    SetEvent, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, EVENT_MODIFY_STATE, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, STARTUPINFOW,
};

const HELPER_ARG: &str = "--deep-student-shell-sandbox-helper";
const PAYLOAD_PREFIX: &str = "deep-student-shell-sandbox-";
const PROFILE_PREFIX: &str = "DeepStudent.LocalShell.";
const UNSANDBOXED_PROFILE_PREFIX: &str = "DeepStudent.DangerShell.";
const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024;
const MAX_POLICY_ROOTS: usize = 128;
const ACTIVE_PROCESS_LIMIT: u32 = 128;
const PROCESS_CPU_TIME_LIMIT_SECS: i64 = 130;
const STALE_PAYLOAD_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn helper_arg() -> &'static str {
    HELPER_ARG
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowsSandboxPayload {
    command: String,
    cwd: PathBuf,
    policy: SandboxPolicy,
    profile_name: String,
    #[serde(default)]
    prefer_git_bash: bool,
    #[serde(default)]
    shell_path: Option<PathBuf>,
    #[serde(default)]
    fallback_shell_path: Option<PathBuf>,
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, context: &str) -> Result<Self, String> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(last_error(context))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct AclMutexGuard(OwnedHandle);

impl Drop for AclMutexGuard {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex((self.0).0);
        }
    }
}

struct Profile {
    name_wide: Vec<u16>,
    sid: PSID,
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            DeleteAppContainerProfile(self.name_wide.as_ptr());
            if !self.sid.is_null() {
                FreeSid(self.sid);
            }
        }
    }
}

struct CapabilityAllocation {
    group_sids: *mut PSID,
    group_count: u32,
    capability_sids: *mut PSID,
    capability_count: u32,
}

impl CapabilityAllocation {
    fn from_name(name: &str) -> Result<Self, String> {
        let name = wide(name);
        let mut allocation = Self {
            group_sids: null_mut(),
            group_count: 0,
            capability_sids: null_mut(),
            capability_count: 0,
        };
        let ok = unsafe {
            DeriveCapabilitySidsFromName(
                name.as_ptr(),
                &mut allocation.group_sids,
                &mut allocation.group_count,
                &mut allocation.capability_sids,
                &mut allocation.capability_count,
            )
        };
        if ok == 0 || allocation.capability_count == 0 {
            return Err(last_error(
                "Failed to derive the AppContainer network capability",
            ));
        }
        Ok(allocation)
    }

    fn attributes(&self) -> Vec<SID_AND_ATTRIBUTES> {
        (0..self.capability_count)
            .map(|index| SID_AND_ATTRIBUTES {
                Sid: unsafe { *self.capability_sids.add(index as usize) },
                Attributes: SE_GROUP_ENABLED as u32,
            })
            .collect()
    }
}

impl Drop for CapabilityAllocation {
    fn drop(&mut self) {
        unsafe {
            free_sid_array(self.group_sids, self.group_count);
            free_sid_array(self.capability_sids, self.capability_count);
        }
    }
}

unsafe fn free_sid_array(values: *mut PSID, count: u32) {
    if values.is_null() {
        return;
    }
    for index in 0..count {
        let sid = unsafe { *values.add(index as usize) };
        if !sid.is_null() {
            unsafe {
                LocalFree(sid as *mut c_void);
            }
        }
    }
    unsafe {
        LocalFree(values as *mut c_void);
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn wide_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn last_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

fn hresult_error(context: &str, result: i32) -> String {
    format!("{context}: HRESULT 0x{:08x}", result as u32)
}

fn job_name(pid: u32) -> String {
    format!("Local\\DeepStudentShellJob-{pid}")
}

fn cancellation_name(pid: u32) -> String {
    format!("Local\\DeepStudentShellCancel-{pid}")
}

fn create_cancellation_event() -> Result<OwnedHandle, String> {
    let name = wide(&cancellation_name(unsafe { GetCurrentProcessId() }));
    OwnedHandle::new(
        unsafe { CreateEventW(null(), 1, 0, name.as_ptr()) },
        "Failed to create the Windows shell cancellation event",
    )
}

fn is_cancelled(event: Option<HANDLE>) -> bool {
    event.is_some_and(|handle| unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0)
}

fn acquire_acl_mutex(cancellation_event: Option<HANDLE>) -> Result<Option<AclMutexGuard>, String> {
    let name = wide("Local\\DeepStudentShellAclMutex-v1");
    let mutex = OwnedHandle::new(
        unsafe { CreateMutexW(null(), 0, name.as_ptr()) },
        "Failed to create the Windows shell ACL mutex",
    )?;
    loop {
        match unsafe { WaitForSingleObject(mutex.0, 100) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED_0 => return Ok(Some(AclMutexGuard(mutex))),
            WAIT_TIMEOUT if is_cancelled(cancellation_event) => return Ok(None),
            WAIT_TIMEOUT => continue,
            _ => return Err(last_error("Failed to acquire the Windows shell ACL mutex")),
        }
    }
}

fn canonical_policy_path(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("Failed to canonicalize Windows sandbox path: {error}"))
}

fn validate_payload(payload: &mut WindowsSandboxPayload) -> Result<(), String> {
    if payload.command.is_empty() || payload.command.contains('\0') {
        return Err("Sandbox command is empty or contains NUL".to_string());
    }
    if !(payload.profile_name.starts_with(PROFILE_PREFIX)
        || payload.profile_name.starts_with(UNSANDBOXED_PROFILE_PREFIX))
        || payload.profile_name.len() > 96
        || !payload
            .profile_name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.')
    {
        return Err("Invalid AppContainer profile name".to_string());
    }
    let total_roots = payload.policy.readable_roots.len()
        + payload.policy.writable_roots.len()
        + payload.policy.protected_read_roots.len()
        + payload.policy.protected_write_roots.len();
    if total_roots > MAX_POLICY_ROOTS {
        return Err("Windows sandbox policy has too many roots".to_string());
    }
    payload.cwd = canonical_policy_path(&payload.cwd)?;
    if !payload.cwd.is_dir() {
        return Err("Windows sandbox cwd is not a directory".to_string());
    }
    for shell_path in [&mut payload.shell_path, &mut payload.fallback_shell_path] {
        if let Some(shell_path) = shell_path.as_mut() {
            *shell_path = canonical_policy_path(shell_path)?;
            let trusted = if payload.prefer_git_bash {
                trusted_git_bash_path().into_iter().collect::<Vec<_>>()
            } else {
                trusted_powershell_paths()?
            };
            let trusted = trusted
                .into_iter()
                .filter_map(|path| path.canonicalize().ok())
                .any(|path| path == *shell_path);
            if !trusted {
                return Err("Windows sandbox payload selected an untrusted shell path".to_string());
            }
        }
    }
    for roots in [
        &mut payload.policy.readable_roots,
        &mut payload.policy.writable_roots,
        &mut payload.policy.protected_read_roots,
        &mut payload.policy.protected_write_roots,
    ] {
        for root in roots {
            *root = canonical_policy_path(root)?;
        }
    }
    if payload.policy.writable_roots.len() > 1
        || payload
            .policy
            .writable_roots
            .first()
            .is_some_and(|root| root != &payload.cwd)
    {
        return Err("Windows sandbox may write only to its selected cwd".to_string());
    }
    Ok(())
}

pub fn payload_root() -> Result<PathBuf, String> {
    let local_app_data = dirs::data_local_dir()
        .ok_or_else(|| "Failed to locate LocalAppData for Windows shell payloads".to_string())?;
    let root = local_app_data
        .join("com.deepstudent.app")
        .join("shell-payloads");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create Windows shell payload directory: {error}"))?;
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve Windows shell payload directory: {error}"))
}

fn payload_file() -> Result<PathBuf, String> {
    Ok(payload_root()?.join(format!("{PAYLOAD_PREFIX}{}.json", Uuid::new_v4().simple())))
}

fn cleanup_stale_payloads() {
    let Ok(root) = payload_root() else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if !name.starts_with(PAYLOAD_PREFIX) || !name.ends_with(".json") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_PAYLOAD_AGE);
        if is_stale {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_payload_file(path: &Path) {
    let Ok(root) = payload_root() else {
        return;
    };
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    let Some(name) = canonical.file_name().and_then(OsStr::to_str) else {
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(&canonical) else {
        return;
    };
    if canonical
        .parent()
        .is_some_and(|parent| windows_paths_equal(parent, &root))
        && name.starts_with(PAYLOAD_PREFIX)
        && name.ends_with(".json")
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = fs::remove_file(canonical);
    }
}

fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    match (left.to_str(), right.to_str()) {
        (Some(left), Some(right)) => {
            crate::pdf_protocol::windows_comparable_path_text(left)
                == crate::pdf_protocol::windows_comparable_path_text(right)
        }
        _ => left == right,
    }
}

fn payload_path_from_command(command: &Command) -> Option<PathBuf> {
    let mut args = command.as_std().get_args();
    if args.next().as_deref() != Some(OsStr::new(HELPER_ARG)) {
        return None;
    }
    args.next().map(PathBuf::from)
}

fn write_payload(payload: &WindowsSandboxPayload) -> Result<PathBuf, String> {
    cleanup_stale_payloads();
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("Failed to encode Windows sandbox payload: {error}"))?;
    if bytes.len() as u64 > MAX_PAYLOAD_BYTES {
        return Err("Windows sandbox payload is too large".to_string());
    }
    let path = payload_file()?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("Failed to create Windows sandbox payload: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(format!(
            "Failed to persist Windows sandbox payload: {error}"
        ));
    }
    Ok(path)
}

fn read_payload(path: &Path) -> Result<WindowsSandboxPayload, String> {
    // TEMP/TMP are rewritten to the command's writable cwd. Authorization must
    // therefore use an independent OS-known root rather than environment or cwd.
    let payload_root = payload_root()?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve Windows sandbox payload: {error}"))?;
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !canonical
        .parent()
        .is_some_and(|parent| windows_paths_equal(parent, &payload_root))
        || !file_name.starts_with(PAYLOAD_PREFIX)
        || !file_name.ends_with(".json")
    {
        return Err("Windows sandbox payload path is not authorized".to_string());
    }
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("Failed to inspect Windows sandbox payload: {error}"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_PAYLOAD_BYTES
    {
        return Err("Windows sandbox payload is not a safe regular file".to_string());
    }
    let bytes = fs::read(&canonical)
        .map_err(|error| format!("Failed to read Windows sandbox payload: {error}"))?;
    fs::remove_file(&canonical)
        .map_err(|error| format!("Failed to consume Windows sandbox payload: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to decode Windows sandbox payload: {error}"))
}

impl SandboxBackend for PlatformSandboxBackend {
    fn capability(&self) -> SandboxCapability {
        match std::env::current_exe() {
            Ok(path) if path.is_file() => SandboxCapability::Available,
            Ok(_) => SandboxCapability::Unavailable {
                reason: "The current executable is not a regular file".to_string(),
            },
            Err(error) => SandboxCapability::Unavailable {
                reason: format!("Cannot locate the AppContainer launcher: {error}"),
            },
        }
    }

    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        if let SandboxCapability::Unavailable { reason } = self.capability() {
            return Err(format!(
                "Local shell sandbox is unavailable; refusing unsandboxed execution: {reason}"
            ));
        }
        let profile_name = format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple());
        let mut shell_paths = trusted_powershell_paths()?.into_iter();
        let shell_path = shell_paths
            .next()
            .expect("PowerShell candidates are non-empty");
        let fallback_shell_path = shell_paths.next();
        let mut policy = policy.clone();
        for parent in [
            shell_path.parent(),
            fallback_shell_path.as_deref().and_then(Path::parent),
        ]
        .into_iter()
        .flatten()
        {
            policy.readable_roots.push(parent.to_path_buf());
        }
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy,
            profile_name,
            prefer_git_bash: false,
            shell_path: Some(shell_path),
            fallback_shell_path,
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the AppContainer launcher: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let payload_root = payload_path
            .parent()
            .ok_or_else(|| "Windows sandbox payload has no parent directory".to_string())?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(&payload_path);
        configure_stdio(&mut command, payload_root);
        Ok(command)
    }

    fn cleanup_command_resources(&self, command: &Command) {
        if let Some(path) = payload_path_from_command(command) {
            cleanup_payload_file(&path);
        }
    }

    fn command_for_git(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        if let SandboxCapability::Unavailable { reason } = self.capability() {
            return Err(format!(
                "Local shell sandbox is unavailable; refusing unsandboxed execution: {reason}"
            ));
        }
        let git_bash = trusted_git_bash_path();
        let prefer_git_bash = git_bash.is_some();
        let (shell_path, fallback_shell_path) = match git_bash {
            Some(path) => (path, None),
            None => {
                let mut paths = trusted_powershell_paths()?.into_iter();
                (
                    paths.next().expect("PowerShell candidates are non-empty"),
                    paths.next(),
                )
            }
        };
        let mut policy = policy.clone();
        if prefer_git_bash {
            if let Some(root) = git_install_root_from_bash(&shell_path) {
                policy.readable_roots.push(root);
            }
        } else {
            for parent in [
                shell_path.parent(),
                fallback_shell_path.as_deref().and_then(Path::parent),
            ]
            .into_iter()
            .flatten()
            {
                policy.readable_roots.push(parent.to_path_buf());
            }
        }
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy,
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash,
            shell_path: Some(shell_path),
            fallback_shell_path,
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the AppContainer launcher: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let payload_root = payload_path
            .parent()
            .ok_or_else(|| "Windows sandbox payload has no parent directory".to_string())?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(&payload_path);
        configure_stdio(&mut command, payload_root);
        Ok(command)
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        let contract = platform_sandbox_contract();
        SandboxEffectReport {
            backend: contract.backend,
            shell_kind: trusted_powershell_path()
                .ok()
                .as_deref()
                .map(powershell_kind)
                .unwrap_or(contract.shell_kind),
            output_encoding: contract.output_encoding,
            enforced: matches!(self.capability(), SandboxCapability::Available),
            network_enforced: true,
            process_group_isolated: true,
            cpu_time_limit_seconds: Some(PROCESS_CPU_TIME_LIMIT_SECS as u64),
            file_size_limit_bytes: None,
            active_process_limit: Some(ACTIVE_PROCESS_LIMIT),
            readable_roots: policy.readable_roots.len(),
            writable_roots: policy.writable_roots.len(),
            protected_read_roots: policy.protected_read_roots.len(),
            protected_write_roots: policy.protected_write_roots.len(),
        }
    }

    fn effect_report_for_git(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        let mut report = self.effect_report(policy);
        if trusted_git_bash_path().is_some() {
            report.shell_kind = "git_bash";
        }
        report
    }
}

impl SandboxBackend for UnsandboxedShellBackend {
    fn capability(&self) -> SandboxCapability {
        match std::env::current_exe() {
            Ok(helper) if helper.is_file() && trusted_powershell_path().is_ok() => {
                SandboxCapability::Available
            }
            Ok(helper) if !helper.is_file() => SandboxCapability::Unavailable {
                reason: "The current executable is not a regular file".to_string(),
            },
            Err(error) => SandboxCapability::Unavailable {
                reason: format!("Cannot locate the Windows Job Object helper: {error}"),
            },
            Ok(_) => SandboxCapability::Unavailable {
                reason: trusted_powershell_path().unwrap_err(),
            },
        }
    }

    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        if let SandboxCapability::Unavailable { reason } = self.capability() {
            return Err(format!(
                "Full Access shell backend is unavailable: {reason}"
            ));
        }
        let mut shell_paths = trusted_powershell_paths()?.into_iter();
        let shell_path = shell_paths
            .next()
            .expect("PowerShell candidates are non-empty");
        let fallback_shell_path = shell_paths.next();
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy: policy.clone(),
            profile_name: format!("{UNSANDBOXED_PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: Some(shell_path),
            fallback_shell_path,
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the Windows Job Object helper: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let payload_root = payload_path
            .parent()
            .ok_or_else(|| "Windows shell payload has no parent directory".to_string())?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(&payload_path);
        configure_stdio(&mut command, payload_root);
        Ok(command)
    }

    fn cleanup_command_resources(&self, command: &Command) {
        if let Some(path) = payload_path_from_command(command) {
            cleanup_payload_file(&path);
        }
    }

    fn command_for_git(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        let git_bash = trusted_git_bash_path();
        let prefer_git_bash = git_bash.is_some();
        let (shell_path, fallback_shell_path) = match git_bash {
            Some(path) => (path, None),
            None => {
                let mut paths = trusted_powershell_paths()?.into_iter();
                (
                    paths.next().expect("PowerShell candidates are non-empty"),
                    paths.next(),
                )
            }
        };
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy: policy.clone(),
            profile_name: format!("{UNSANDBOXED_PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash,
            shell_path: Some(shell_path),
            fallback_shell_path,
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the Windows Job Object helper: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let payload_root = payload_path
            .parent()
            .ok_or_else(|| "Windows shell payload has no parent directory".to_string())?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(&payload_path);
        configure_stdio(&mut command, payload_root);
        Ok(command)
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "unsandboxed_job",
            shell_kind: trusted_powershell_path()
                .ok()
                .as_deref()
                .map(powershell_kind)
                .unwrap_or("windows_powershell"),
            output_encoding: "utf-8",
            enforced: false,
            network_enforced: false,
            process_group_isolated: true,
            // 完全信任通道的 Job 仅设置 KILL_ON_JOB_CLOSE（进程树回收），
            // 不施加 CPU/进程数资源限制；与 Unix unsandboxed 报告保持一致。
            cpu_time_limit_seconds: None,
            file_size_limit_bytes: None,
            active_process_limit: None,
            readable_roots: policy.readable_roots.len(),
            writable_roots: policy.writable_roots.len(),
            protected_read_roots: policy.protected_read_roots.len(),
            protected_write_roots: policy.protected_write_roots.len(),
        }
    }

    fn effect_report_for_git(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        let mut report = self.effect_report(policy);
        if trusted_git_bash_path().is_some() {
            report.shell_kind = "git_bash";
        }
        report
    }
}

/// Unrestricted host-shell backend (Craft + `DangerFullAccess` after the
/// explicit one-shot backend confirmation). It spawns the trusted System32
/// Windows PowerShell directly from this process: no helper process, no
/// payload file, no AppContainer/ACL rewriting, and no helper→PowerShell
/// double hop. The only lifecycle resource is a kill-on-close Job Object
/// created in-process, used for cancellation and app-exit process-tree
/// reclamation — never CPU/process-count/file-size limits. Access-class
/// policy (command rules, guards, env, output bounds) lives in the executor.
pub struct DirectHostShellBackend {
    /// Per-execution Job Object: created in `command()`, bound to the live
    /// child in `on_child_spawned()`, dropped in `cleanup_command_resources()`
    /// (the drop fires KILL_ON_JOB_CLOSE and reclaims any survivors).
    job: Mutex<Option<OwnedHandle>>,
}

// SAFETY: the only interior state is a raw Windows HANDLE guarded by a Mutex.
// HANDLEs are plain integer-like tokens safe to move between threads, and all
// accesses are serialized, so the backend is neither racy nor thread-bound.
unsafe impl Send for DirectHostShellBackend {}
unsafe impl Sync for DirectHostShellBackend {}

impl Default for DirectHostShellBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl DirectHostShellBackend {
    pub fn new() -> Self {
        Self {
            job: Mutex::new(None),
        }
    }

    fn job_lock(&self) -> std::sync::MutexGuard<'_, Option<OwnedHandle>> {
        self.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SandboxBackend for DirectHostShellBackend {
    fn capability(&self) -> SandboxCapability {
        match trusted_powershell_path() {
            Ok(path) if path.is_file() => SandboxCapability::Available,
            Ok(_) => SandboxCapability::Unavailable {
                reason: "trusted Windows PowerShell is not a regular file".to_string(),
            },
            Err(reason) => SandboxCapability::Unavailable { reason },
        }
    }

    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        _policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        if let SandboxCapability::Unavailable { reason } = self.capability() {
            return Err(format!("Unrestricted host shell backend is unavailable: {reason}"));
        }
        let powershell = trusted_powershell_path()?;
        // Lifecycle Job first so the spawn hook can bind the child even when
        // the command finishes within milliseconds. Must be anonymous: a fixed
        // per-process name would be shared by all concurrent unrestricted
        // executions in this process, so terminating one would kill the rest.
        let job = create_anonymous_job(true)?;
        *self.job_lock() = Some(job);
        let mut command = Command::new(powershell);
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded_powershell_command(shell_command),
        ]);
        configure_stdio(&mut command, cwd);
        Ok(command)
    }

    fn on_child_spawned(&self, child: &mut Child) -> Result<(), String> {
        let Some(process_handle) = child.raw_handle() else {
            return Err("Unrestricted host shell child has no raw process handle".to_string());
        };
        let job_guard = self.job_lock();
        let Some(job) = job_guard.as_ref() else {
            // Backend already cleaned up (spawn failure path); nothing to bind.
            return Ok(());
        };
        if unsafe { AssignProcessToJobObject(job.0, process_handle) } == 0 {
            // A millisecond command may have exited before the assignment; the
            // result is already produced, so an exited child is not an error.
            if child
                .try_wait()
                .map_err(|error| format!("Failed to inspect the unrestricted host shell: {error}"))?
                .is_some()
            {
                return Ok(());
            }
            return Err(last_error(
                "Failed to bind the unrestricted host shell to its Job Object",
            ));
        }
        Ok(())
    }

    fn terminate_child(&self, child: &mut Child) -> Result<(), String> {
        {
            let job_guard = self.job_lock();
            if let Some(job) = job_guard.as_ref() {
                if unsafe { TerminateJobObject(job.0, 124) } != 0 {
                    return Ok(());
                }
            }
        }
        // Job termination failed (or was already dropped): fall back to a
        // synchronous direct kill of the shell process itself.
        child
            .start_kill()
            .map_err(|error| format!("Failed to kill the unrestricted host shell: {error}"))
    }

    fn cleanup_command_resources(&self, _command: &Command) {
        // Dropping the Job handle fires KILL_ON_JOB_CLOSE, reclaiming any
        // survivors after cancellation, timeout, or normal exit.
        *self.job_lock() = None;
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "direct_host_unrestricted",
            shell_kind: trusted_powershell_path()
                .ok()
                .as_deref()
                .map(powershell_kind)
                .unwrap_or("windows_powershell"),
            output_encoding: "utf-8",
            enforced: false,
            network_enforced: false,
            process_group_isolated: true,
            // The in-process Job only provides process-tree reclamation; no
            // resource limits exist in this tier.
            cpu_time_limit_seconds: None,
            file_size_limit_bytes: None,
            active_process_limit: None,
            readable_roots: policy.readable_roots.len(),
            writable_roots: policy.writable_roots.len(),
            protected_read_roots: policy.protected_read_roots.len(),
            protected_write_roots: policy.protected_write_roots.len(),
        }
    }
}

fn trustee(sid: PSID) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    }
}

/// A protected root whose DACL was rewritten by [`protect_path`]; restored by
/// [`unprotect_path`].
struct ProtectedPath {
    path: PathBuf,
    was_protected: bool,
}

/// Cut a protected root out of the sandbox SID's granted namespace.
///
/// Granting a writable/readable root propagates an inheritable allow ACE for
/// the sandbox SID onto every existing descendant, and the AppContainer
/// access check honors that allow even when an explicit deny ACE for the same
/// SID is present (observed on Windows Server runners: a canonical,
/// first-position deny did not stop writes while an inherited allow existed).
/// Protection therefore cannot rely on deny ACEs alone — the protected
/// subtree must carry *no* allow for the sandbox SID at all.
///
/// This rewrites the root's DACL to [deny `deny_rights`] (+ [allow read] when
/// `preserve_read`) + [old ACEs except the sandbox SID's], and sets
/// SE_DACL_PROTECTED so the later parent grants cannot propagate in. Setting
/// the DACL also propagates these ACEs to existing descendants, so the whole
/// subtree is covered with one call. [`unprotect_path`] restores the exact
/// original DACL and inheritance state after the sandboxed run.
fn protect_path(
    path: &Path,
    sid: PSID,
    deny_rights: u32,
    preserve_read: bool,
) -> Result<ProtectedPath, String> {
    let mut path_wide = wide_os(path.as_os_str());
    let mut old_acl: *mut ACL = null_mut();
    let mut security_descriptor: *mut c_void = null_mut();
    let get_result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get_result != 0 {
        return Err(format!(
            "Failed to read ACL for '{}': Win32 error {get_result}",
            path.display()
        ));
    }

    let result = (|| {
        if old_acl.is_null() {
            // A null DACL grants full control to everyone. Replacing it with a
            // partial DACL would lock out legitimate users, while an allow for
            // Everyone would still satisfy the AppContainer check. Fail closed.
            return Err(format!(
                "Refusing to protect '{}' which has a null DACL",
                path.display()
            ));
        }
        let mut control: u16 = 0;
        let mut revision: u32 = 0;
        if unsafe { GetSecurityDescriptorControl(security_descriptor, &mut control, &mut revision) }
            == 0
        {
            let error = std::io::Error::last_os_error();
            return Err(format!(
                "Failed to read security descriptor control for '{}': {error}",
                path.display()
            ));
        }
        let was_protected = control & SE_DACL_PROTECTED != 0;

        let sid_len = unsafe { GetLengthSid(sid) } as usize;
        let deny_ace_len = size_of::<ACCESS_DENIED_ACE>() - size_of::<u32>() + sid_len;
        let old_len = unsafe { (*old_acl).AclSize as usize };
        // usize storage keeps the buffer DWORD-aligned; slack covers padding
        // for the deny ACE plus the optional read-preservation ACE.
        let new_len = old_len + 2 * deny_ace_len + 64;
        let mut storage = vec![0usize; new_len.div_ceil(size_of::<usize>())];
        let new_acl = storage.as_mut_ptr() as *mut ACL;
        if unsafe { InitializeAcl(new_acl, new_len as u32, ACL_REVISION) } == 0 {
            let error = std::io::Error::last_os_error();
            return Err(format!(
                "Failed to initialize ACL for '{}': {error}",
                path.display()
            ));
        }
        if unsafe {
            AddAccessDeniedAceEx(
                new_acl,
                ACL_REVISION,
                SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                deny_rights,
                sid,
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            return Err(format!(
                "Failed to add deny ACE for '{}': {error}",
                path.display()
            ));
        }
        if preserve_read
            && unsafe {
                AddAccessAllowedAceEx(
                    new_acl,
                    ACL_REVISION,
                    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                    FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                    sid,
                )
            } == 0
        {
            let error = std::io::Error::last_os_error();
            return Err(format!(
                "Failed to add read-preservation ACE for '{}': {error}",
                path.display()
            ));
        }
        let ace_count = unsafe { (*old_acl).AceCount } as u32;
        for index in 0..ace_count {
            let mut ace: *mut c_void = null_mut();
            if unsafe { GetAce(old_acl, index, &mut ace) } == 0 {
                let error = std::io::Error::last_os_error();
                return Err(format!(
                    "Failed to read existing ACE {index} for '{}': {error}",
                    path.display()
                ));
            }
            let header = unsafe { *(ace as *const ACE_HEADER) };
            // Strip any allow/deny the sandbox SID already has here (e.g.
            // propagated by a grant on an overlapping root): one matching
            // allow is enough for the AppContainer check to regain access.
            // AceType 0 = access-allowed, 1 = access-denied; both share the
            // ACCESS_DENIED_ACE layout.
            if header.AceType <= 1 {
                let ace_sid =
                    unsafe { &(*(ace as *const ACCESS_DENIED_ACE)).SidStart as *const u32 as PSID };
                if unsafe { EqualSid(ace_sid, sid) } != 0 {
                    continue;
                }
            }
            if unsafe { AddAce(new_acl, ACL_REVISION, u32::MAX, ace, header.AceSize as u32) } == 0 {
                let error = std::io::Error::last_os_error();
                return Err(format!(
                    "Failed to copy existing ACE {index} for '{}': {error}",
                    path.display()
                ));
            }
        }
        let set_result = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_acl,
                null_mut(),
            )
        };
        if set_result != 0 {
            return Err(format!(
                "Failed to apply ACL for '{}': Win32 error {set_result}",
                path.display()
            ));
        }
        Ok(ProtectedPath {
            path: path.to_path_buf(),
            was_protected,
        })
    })();
    unsafe {
        LocalFree(security_descriptor);
    }
    result
}

/// Restore a protected root to its original DACL and inheritance state.
///
/// Revoking the sandbox SID's ACEs and writing the DACL back propagates the
/// removal through the subtree, and re-specifying the original protection
/// state re-enables (or keeps) inheritance exactly as before.
fn unprotect_path(protected: &ProtectedPath, sid: PSID) {
    if !protected.path.exists() {
        return;
    }
    let _ = change_path_acl(&protected.path, sid, REVOKE_ACCESS, 0);
    if protected.was_protected {
        return;
    }
    let mut path_wide = wide_os(protected.path.as_os_str());
    let mut current_acl: *mut ACL = null_mut();
    let mut security_descriptor: *mut c_void = null_mut();
    let get_result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut current_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get_result != 0 {
        return;
    }
    let _ = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            current_acl,
            null_mut(),
        )
    };
    unsafe {
        LocalFree(security_descriptor);
    }
}

fn change_path_acl(path: &Path, sid: PSID, mode: i32, rights: u32) -> Result<(), String> {
    let mut path_wide = wide_os(path.as_os_str());
    let mut old_acl: *mut ACL = null_mut();
    let mut security_descriptor: *mut c_void = null_mut();
    let get_result = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get_result != 0 {
        return Err(format!(
            "Failed to read ACL for '{}': Win32 error {get_result}",
            path.display()
        ));
    }

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: mode,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: trustee(sid),
    };
    let mut new_acl: *mut ACL = null_mut();
    let acl_result = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
    if acl_result != 0 {
        unsafe {
            LocalFree(security_descriptor);
        }
        return Err(format!(
            "Failed to update ACL for '{}': Win32 error {acl_result}",
            path.display()
        ));
    }
    let set_result = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_acl,
            null_mut(),
        )
    };
    unsafe {
        LocalFree(new_acl as *mut c_void);
        LocalFree(security_descriptor);
    }
    if set_result != 0 {
        return Err(format!(
            "Failed to apply ACL for '{}': Win32 error {set_result}",
            path.display()
        ));
    }
    Ok(())
}

fn grant_policy(
    policy: &SandboxPolicy,
    sid: PSID,
) -> Result<(Vec<PathBuf>, Vec<ProtectedPath>), String> {
    let read = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let write = read | FILE_GENERIC_WRITE | FILE_DELETE_CHILD | DELETE;
    let mut granted = Vec::new();
    let mut protected = Vec::new();
    let mut seen_grants = BTreeSet::new();
    let mut seen_protected = BTreeSet::new();

    let is_exposed = |path: &Path| {
        policy
            .readable_roots
            .iter()
            .chain(&policy.writable_roots)
            .any(|root| path.starts_with(root) || root.starts_with(path))
    };

    let result = (|| {
        // Seal exposed protected roots BEFORE granting anything. A grant on a
        // parent root propagates an inheritable allow for the sandbox SID onto
        // every existing descendant, and the AppContainer access check honors
        // such an allow even when an explicit deny ACE for the same SID is
        // present — so the protected subtree must be cut out of the sandbox
        // SID's granted namespace before any grant happens. Read protection
        // is the stricter rule and wins when a path sits in both lists.
        for path in &policy.protected_read_roots {
            if is_exposed(path) && path.exists() && seen_protected.insert(path.to_path_buf()) {
                protected.push(protect_path(path, sid, write, false)?);
            }
        }
        for path in &policy.protected_write_roots {
            if is_exposed(path) && path.exists() && seen_protected.insert(path.to_path_buf()) {
                protected.push(protect_path(
                    path,
                    sid,
                    FILE_GENERIC_WRITE | FILE_DELETE_CHILD | DELETE,
                    true,
                )?);
            }
        }
        for path in &policy.readable_roots {
            // Windows and Program Files roots commonly already grant
            // AppContainer read/execute through inherited package ACLs while
            // denying WRITE_DAC to a normal desktop user. A failed redundant
            // read grant must not make every shell command unavailable. Keep
            // write grants and all protection rules fail-closed.
            if !path.exists() || !seen_grants.insert((path.to_path_buf(), read)) {
                continue;
            }
            match change_path_acl(path, sid, GRANT_ACCESS, read) {
                Ok(()) => granted.push(path.to_path_buf()),
                Err(error) => log::warn!(
                    "[WindowsSandbox] Continuing after optional read ACL grant failed: {}",
                    error
                ),
            }
        }
        for path in &policy.writable_roots {
            if !path.exists() || !seen_grants.insert((path.to_path_buf(), write)) {
                continue;
            }
            change_path_acl(path, sid, GRANT_ACCESS, write)?;
            granted.push(path.to_path_buf());
        }
        Ok(())
    })();

    if let Err(error) = result {
        revoke_policy(&granted, &protected, sid);
        return Err(error);
    }
    Ok((granted, protected))
}

fn revoke_policy(granted: &[PathBuf], protected: &[ProtectedPath], sid: PSID) {
    let mut unique = BTreeSet::new();
    for path in granted.iter().rev() {
        if unique.insert(path) && path.exists() {
            let _ = change_path_acl(path, sid, REVOKE_ACCESS, 0);
        }
    }
    for entry in protected.iter().rev() {
        unprotect_path(entry, sid);
    }
}

fn create_profile(name: &str, capabilities: &[SID_AND_ATTRIBUTES]) -> Result<Profile, String> {
    let name_wide = wide(name);
    let display_name = wide("Deep Student local shell");
    let description = wide("Ephemeral AppContainer for an approved local shell command");
    let mut sid: PSID = null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            name_wide.as_ptr(),
            display_name.as_ptr(),
            description.as_ptr(),
            if capabilities.is_empty() {
                null()
            } else {
                capabilities.as_ptr()
            },
            capabilities.len() as u32,
            &mut sid,
        )
    };
    if result < 0 {
        return Err(hresult_error(
            "Failed to create AppContainer profile",
            result,
        ));
    }
    Ok(Profile { name_wide, sid })
}

fn job_limit_information() -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_TIME;
    limits.BasicLimitInformation.ActiveProcessLimit = ACTIVE_PROCESS_LIMIT;
    limits.BasicLimitInformation.PerProcessUserTimeLimit = PROCESS_CPU_TIME_LIMIT_SECS * 10_000_000;
    limits
}

/// 完全信任（Danger Full Access）通道的 Job Object：仅保留
/// KILL_ON_JOB_CLOSE（进程树清理），不施加 CPU 时间 / 进程数上限——
/// 用户显式选择完全信任后，npm install 等长任务不应再被沙箱资源策略杀死。
fn relaxed_job_limit_information() -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits
}

fn create_job(relaxed: bool) -> Result<OwnedHandle, String> {
    let name = wide(&job_name(unsafe { GetCurrentProcessId() }));
    create_job_object(relaxed, name.as_ptr())
}

/// 匿名 Job Object（DirectHostShellBackend 专用）。主进程内若沿用固定名
/// `Local\DeepStudentShellJob-{pid}`，CreateJobObjectW 对同名对象返回既有
/// 句柄，并发的无限制执行会共享同一 Job，terminate_child 的
/// TerminateJobObject 会跨执行误杀无关进程树。匿名 Job 由 backend 实例
/// 自持句柄（on_child_spawned / terminate_child / cleanup 全部经句柄），
/// 不依赖按名查找。
fn create_anonymous_job(relaxed: bool) -> Result<OwnedHandle, String> {
    create_job_object(relaxed, null())
}

fn create_job_object(relaxed: bool, name: *const u16) -> Result<OwnedHandle, String> {
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(null(), name) },
        "Failed to create the Windows shell Job Object",
    )?;
    let limits = if relaxed {
        relaxed_job_limit_information()
    } else {
        job_limit_information()
    };
    let ok = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_error(
            "Failed to configure the Windows shell Job Object",
        ));
    }
    Ok(job)
}

fn trusted_windows_powershell_path() -> Result<PathBuf, String> {
    let mut system_directory = vec![0u16; 32_768];
    let length = unsafe {
        GetSystemDirectoryW(system_directory.as_mut_ptr(), system_directory.len() as u32)
    };
    if length == 0 {
        return Err(last_error(
            "Failed to resolve the trusted Windows system directory",
        ));
    }
    if length as usize >= system_directory.len() {
        return Err("The trusted Windows system directory path is too long".to_string());
    }
    let system_directory = PathBuf::from(String::from_utf16_lossy(
        &system_directory[..length as usize],
    ));
    let powershell = system_directory
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell.is_file() {
        return Err(format!(
            "Trusted Windows PowerShell executable is unavailable: {}",
            powershell.display()
        ));
    }
    Ok(powershell)
}

fn trusted_powershell_paths() -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for key in ["ProgramW6432", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(key) {
            let pwsh = PathBuf::from(root)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            if pwsh.is_file() && !paths.contains(&pwsh) {
                paths.push(pwsh);
                break;
            }
        }
    }
    paths.push(trusted_windows_powershell_path()?);
    Ok(paths)
}

fn trusted_powershell_path() -> Result<PathBuf, String> {
    trusted_powershell_paths()?
        .into_iter()
        .next()
        .ok_or_else(|| "No trusted PowerShell executable is available".to_string())
}

fn powershell_kind(path: &Path) -> &'static str {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("pwsh.exe"))
    {
        "windows_powershell_7"
    } else {
        "windows_powershell_5_1"
    }
}

pub(crate) fn trusted_git_bash_path() -> Option<PathBuf> {
    for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(key) else {
            continue;
        };
        for relative in [
            Path::new(r"Git\bin\bash.exe"),
            Path::new(r"Git\usr\bin\bash.exe"),
        ] {
            let bash = PathBuf::from(&root).join(relative);
            if bash.is_file() {
                return Some(bash);
            }
        }
    }
    None
}

fn git_install_root_from_bash(bash: &Path) -> Option<PathBuf> {
    let bin = bash.parent()?;
    let parent = bin.parent()?;
    if parent
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("usr"))
    {
        parent.parent().map(Path::to_path_buf)
    } else {
        Some(parent.to_path_buf())
    }
}

fn encoded_powershell_command(command: &str) -> String {
    let script = format!(
        "$utf8 = [System.Text.UTF8Encoding]::new($false)\n\
         try {{ [Console]::InputEncoding = $utf8 }} catch {{}}\n\
         try {{ [Console]::OutputEncoding = $utf8 }} catch {{}}\n\
         $OutputEncoding = $utf8\n\
         $ProgressPreference = 'SilentlyContinue'\n\
         $deepStudentShellKind = if ($PSVersionTable.PSVersion.Major -ge 6) {{ 'windows_powershell_7' }} else {{ 'windows_powershell_5_1' }}\n\
         [Console]::Error.WriteLine('__DEEP_STUDENT_SHELL_KIND__=' + $deepStudentShellKind)\n\
         $global:LASTEXITCODE = 0\n\
         & {{\n{command}\n}}\n\
         $deepStudentSucceeded = $?\n\
         $deepStudentExitCode = $global:LASTEXITCODE\n\
         if (-not $deepStudentSucceeded -and $deepStudentExitCode -eq 0) {{ exit 1 }}\n\
         exit $deepStudentExitCode"
    );
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    BASE64.encode(bytes)
}

fn windows_command_line_arg(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            quoted.push(ch);
        }
        backslashes = 0;
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn command_line(
    command: &str,
    prefer_git_bash: bool,
    selected_shell: Option<&Path>,
) -> Result<(Vec<u16>, Vec<u16>), String> {
    if prefer_git_bash {
        if let Some(bash) = selected_shell
            .map(Path::to_path_buf)
            .or_else(trusted_git_bash_path)
        {
            let application = wide_os(bash.as_os_str());
            // Direct bash.exe startup bypasses git-bash.exe's PATH setup.
            let command = format!("export PATH=\"/cmd:/usr/bin:$PATH\"; {command}");
            let line = format!(
                "\"{}\" --noprofile --norc -c {}",
                bash.display(),
                windows_command_line_arg(&command)
            );
            return Ok((application, wide(&line)));
        }
    }
    let powershell = selected_shell
        .map(Path::to_path_buf)
        .map(Ok)
        .unwrap_or_else(trusted_powershell_path)?;
    let application = wide_os(powershell.as_os_str());
    let encoded = encoded_powershell_command(command);
    let line = format!(
        "\"{}\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell.display(),
        encoded
    );
    Ok((application, wide(&line)))
}

fn run_payload(
    mut payload: WindowsSandboxPayload,
    cancellation_event: Option<HANDLE>,
) -> Result<i32, String> {
    validate_payload(&mut payload)?;
    if payload.profile_name.starts_with(UNSANDBOXED_PROFILE_PREFIX) {
        if is_cancelled(cancellation_event) {
            return Ok(124);
        }
        if !payload.prefer_git_bash {
            let mut probe = payload.clone();
            probe.command = "$null".to_string();
            let mut probe_exit = run_unsandboxed_job_process(&probe, cancellation_event)?;
            if probe_exit != 0 {
                if is_cancelled(cancellation_event) {
                    return Ok(124);
                }
                let Some(fallback) = payload.fallback_shell_path.take() else {
                    eprintln!(
                        "PowerShell failed its startup probe with exit code 0x{:08X}",
                        probe_exit as u32
                    );
                    return Ok(probe_exit);
                };
                eprintln!(
                    "Preferred PowerShell failed its startup probe; retrying with {}",
                    fallback.display()
                );
                payload.shell_path = Some(fallback);
                probe = payload.clone();
                probe.command = "$null".to_string();
                probe_exit = run_unsandboxed_job_process(&probe, cancellation_event)?;
                if probe_exit != 0 {
                    if is_cancelled(cancellation_event) {
                        return Ok(124);
                    }
                    eprintln!(
                        "Fallback PowerShell failed its startup probe with exit code 0x{:08X}",
                        probe_exit as u32
                    );
                    return Ok(probe_exit);
                }
            }
        }
        if is_cancelled(cancellation_event) {
            return Ok(124);
        }
        return run_unsandboxed_job_process(&payload, cancellation_event);
    }
    let Some(_acl_guard) = acquire_acl_mutex(cancellation_event)? else {
        return Ok(124);
    };
    if is_cancelled(cancellation_event) {
        return Ok(124);
    }
    let capability_allocations = if payload.policy.allow_network {
        // internetClient 放行公网；privateNetworkClientServer 放行私网/本机
        // 网络服务（AppContainer 默认连私网一并隔离）。注意：严格的
        // 127.0.0.1 loopback 豁免需要 CheckNetIsolation LoopbackExempt +
        // PackageFamilyName，临时 AppContainer 没有包族无法注册——
        // 必须访问 127.0.0.1 的场景请走完全信任档（非沙箱通道）。
        let mut allocations = Vec::new();
        for name in ["internetClient", "privateNetworkClientServer"] {
            allocations.push(CapabilityAllocation::from_name(name)?);
        }
        allocations
    } else {
        Vec::new()
    };
    let capabilities: Vec<SID_AND_ATTRIBUTES> = capability_allocations
        .iter()
        .flat_map(CapabilityAllocation::attributes)
        .collect();
    let profile = create_profile(&payload.profile_name, &capabilities)?;
    let (granted_paths, protected_paths) = grant_policy(&payload.policy, profile.sid)?;
    let result = (|| {
        if !payload.prefer_git_bash {
            let mut probe = payload.clone();
            probe.command = "$null".to_string();
            let mut probe_exit =
                run_appcontainer_process(&probe, profile.sid, &capabilities, cancellation_event)?;
            if probe_exit != 0 {
                if is_cancelled(cancellation_event) {
                    return Ok(124);
                }
                let Some(fallback) = payload.fallback_shell_path.take() else {
                    eprintln!(
                        "PowerShell failed its AppContainer startup probe with exit code 0x{:08X}",
                        probe_exit as u32
                    );
                    return Ok(probe_exit);
                };
                eprintln!(
                    "Preferred PowerShell failed its AppContainer startup probe; retrying with {}",
                    fallback.display()
                );
                payload.shell_path = Some(fallback);
                probe = payload.clone();
                probe.command = "$null".to_string();
                probe_exit = run_appcontainer_process(
                    &probe,
                    profile.sid,
                    &capabilities,
                    cancellation_event,
                )?;
                if probe_exit != 0 {
                    if is_cancelled(cancellation_event) {
                        return Ok(124);
                    }
                    eprintln!(
                        "Fallback PowerShell failed its AppContainer startup probe with exit code 0x{:08X}",
                        probe_exit as u32
                    );
                    return Ok(probe_exit);
                }
            }
        }
        if is_cancelled(cancellation_event) {
            Ok(124)
        } else {
            run_appcontainer_process(&payload, profile.sid, &capabilities, cancellation_event)
        }
    })();
    revoke_policy(&granted_paths, &protected_paths, profile.sid);
    result
}

fn run_unsandboxed_job_process(
    payload: &WindowsSandboxPayload,
    cancellation_event: Option<HANDLE>,
) -> Result<i32, String> {
    // 完全信任通道：仅保留进程树清理，不施加 CPU/进程数上限。
    let job = create_job(true)?;
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };

    let (application, mut command_line) = command_line(
        &payload.command,
        payload.prefer_git_bash,
        payload.shell_path.as_deref(),
    )?;
    let cwd = wide_os(payload.cwd.as_os_str());
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1 as BOOL,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            null(),
            cwd.as_ptr(),
            &startup,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(last_error(
            "Failed to create the Danger Full Access PowerShell process",
        ));
    }
    let process = OwnedHandle::new(
        process_info.hProcess,
        "Invalid Danger Full Access process handle",
    )?;
    let thread_handle = match OwnedHandle::new(
        process_info.hThread,
        "Invalid Danger Full Access thread handle",
    ) {
        Ok(handle) => handle,
        Err(error) => {
            unsafe {
                TerminateProcess(process.0, 126);
            }
            return Err(error);
        }
    };
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        unsafe {
            TerminateProcess(process.0, 126);
        }
        return Err(last_error(
            "Failed to assign Danger Full Access PowerShell to its Job Object",
        ));
    }
    if is_cancelled(cancellation_event) {
        return Ok(124);
    }
    if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
        return Err(last_error("Failed to resume Danger Full Access PowerShell"));
    }
    loop {
        match unsafe { WaitForSingleObject(process.0, 100) } {
            WAIT_OBJECT_0 => break,
            WAIT_TIMEOUT if is_cancelled(cancellation_event) => {
                if unsafe { TerminateJobObject(job.0, 124) } == 0 {
                    return Err(last_error(
                        "Failed to terminate the cancelled Danger Full Access Job Object",
                    ));
                }
                if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
                    return Err(last_error(
                        "Failed while waiting for cancelled Danger Full Access PowerShell",
                    ));
                }
                break;
            }
            WAIT_TIMEOUT => continue,
            _ => {
                return Err(last_error(
                    "Failed while waiting for Danger Full Access PowerShell",
                ));
            }
        }
    }
    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(process.0, &mut exit_code) } == 0 {
        return Err(last_error(
            "Failed to obtain Danger Full Access PowerShell exit code",
        ));
    }
    Ok(exit_code as i32)
}

fn run_appcontainer_process(
    payload: &WindowsSandboxPayload,
    appcontainer_sid: PSID,
    capabilities: &[SID_AND_ATTRIBUTES],
    cancellation_event: Option<HANDLE>,
) -> Result<i32, String> {
    let job = create_job(false)?;
    if is_cancelled(cancellation_event) {
        return Ok(124);
    }
    let mut security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: appcontainer_sid,
        Capabilities: capabilities.as_ptr() as *mut SID_AND_ATTRIBUTES,
        CapabilityCount: capabilities.len() as u32,
        Reserved: 0,
    };

    let mut attribute_bytes = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
    }
    if attribute_bytes == 0 {
        return Err(last_error(
            "Failed to size the AppContainer process attribute list",
        ));
    }
    let words = attribute_bytes.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut _;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) } == 0
    {
        return Err(last_error(
            "Failed to initialize the AppContainer process attribute list",
        ));
    }
    let update_ok = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut security_capabilities as *mut _ as *const c_void,
            size_of::<SECURITY_CAPABILITIES>(),
            null_mut(),
            null(),
        )
    };
    if update_ok == 0 {
        unsafe {
            DeleteProcThreadAttributeList(attribute_list);
        }
        return Err(last_error(
            "Failed to attach AppContainer security capabilities",
        ));
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    startup.lpAttributeList = attribute_list;

    let (application, mut command_line) = command_line(
        &payload.command,
        payload.prefer_git_bash,
        payload.shell_path.as_deref(),
    )?;
    let cwd = wide_os(payload.cwd.as_os_str());
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1 as BOOL,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    unsafe {
        DeleteProcThreadAttributeList(attribute_list);
    }
    if created == 0 {
        return Err(last_error(
            "Failed to create the AppContainer shell process",
        ));
    }
    let process = OwnedHandle::new(process_info.hProcess, "Invalid AppContainer process handle")?;
    let thread_handle =
        match OwnedHandle::new(process_info.hThread, "Invalid AppContainer thread handle") {
            Ok(handle) => handle,
            Err(error) => {
                unsafe {
                    TerminateProcess(process.0, 126);
                }
                return Err(error);
            }
        };

    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        unsafe {
            TerminateProcess(process.0, 126);
        }
        return Err(last_error(
            "Failed to assign the AppContainer process to its Job Object",
        ));
    }
    if is_cancelled(cancellation_event) {
        return Ok(124);
    }
    if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
        return Err(last_error(
            "Failed to resume the AppContainer shell process",
        ));
    }
    loop {
        match unsafe { WaitForSingleObject(process.0, 100) } {
            WAIT_OBJECT_0 => break,
            WAIT_TIMEOUT if is_cancelled(cancellation_event) => {
                if unsafe { TerminateJobObject(job.0, 124) } == 0 {
                    return Err(last_error(
                        "Failed to terminate the cancelled Windows shell Job Object",
                    ));
                }
                if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
                    return Err(last_error(
                        "Failed while waiting for the cancelled AppContainer shell process",
                    ));
                }
                break;
            }
            WAIT_TIMEOUT => continue,
            _ => {
                return Err(last_error(
                    "Failed while waiting for the AppContainer shell process",
                ));
            }
        }
    }
    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(process.0, &mut exit_code) } == 0 {
        return Err(last_error(
            "Failed to obtain the AppContainer shell exit code",
        ));
    }
    Ok(exit_code as i32)
}

pub fn maybe_run_helper() -> Option<i32> {
    let mut args = std::env::args_os();
    let _executable = args.next();
    if args.next().as_deref() != Some(OsStr::new(HELPER_ARG)) {
        return None;
    }
    let result = create_cancellation_event().and_then(|cancellation_event| {
        args.next()
            .ok_or_else(|| "Windows sandbox helper payload path is missing".to_string())
            .and_then(|path| read_payload(Path::new(&path)))
            .and_then(|payload| run_payload(payload, Some(cancellation_event.0)))
    });
    match result {
        Ok(exit_code) => Some(exit_code),
        Err(error) => {
            eprintln!("Windows local shell sandbox failed: {error}");
            Some(126)
        }
    }
}

pub fn terminate_job_for_child(child: &mut Child) -> Result<(), String> {
    let pid = child
        .id()
        .ok_or_else(|| "Sandboxed shell helper has no process id".to_string())?;
    let cancellation = wide(&cancellation_name(pid));
    for _ in 0..100 {
        if child
            .try_wait()
            .map_err(|error| format!("Failed to inspect Windows shell helper: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, cancellation.as_ptr()) };
        if !handle.is_null() {
            let event = OwnedHandle(handle);
            if unsafe { SetEvent(event.0) } == 0 {
                return Err(last_error(
                    "Failed to signal the Windows shell cancellation event",
                ));
            }
            let job_name = wide(&job_name(pid));
            let job_handle = unsafe { OpenJobObjectW(JOB_OBJECT_TERMINATE, 0, job_name.as_ptr()) };
            if !job_handle.is_null() {
                let job = OwnedHandle(job_handle);
                if unsafe { TerminateJobObject(job.0, 124) } == 0 {
                    return Err(last_error(
                        "Failed to terminate the Windows shell Job Object",
                    ));
                }
            }
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_FILE_NOT_FOUND as i32) {
            return Err(format!(
                "Failed to open the Windows shell cancellation event: {error}"
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }

    let name = wide(&job_name(pid));
    for _ in 0..100 {
        if child
            .try_wait()
            .map_err(|error| format!("Failed to inspect Windows shell helper: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        let handle = unsafe { OpenJobObjectW(JOB_OBJECT_TERMINATE, 0, name.as_ptr()) };
        if !handle.is_null() {
            let job = OwnedHandle(handle);
            if unsafe { TerminateJobObject(job.0, 124) } == 0 {
                return Err(last_error(
                    "Failed to terminate the Windows shell Job Object",
                ));
            }
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_FILE_NOT_FOUND as i32) {
            return Err(format!(
                "Failed to open the Windows shell Job Object: {error}"
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    child
        .start_kill()
        .map_err(|error| format!("Failed to terminate the Windows shell helper: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn policy(readable: &Path, writable: &Path) -> SandboxPolicy {
        SandboxPolicy {
            readable_roots: vec![readable.to_path_buf()],
            writable_roots: vec![writable.to_path_buf()],
            protected_read_roots: Vec::new(),
            protected_write_roots: Vec::new(),
            restrict_read_to_roots: false,
            allow_network: false,
        }
    }

    #[test]
    fn payload_validation_rejects_write_root_other_than_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut payload = WindowsSandboxPayload {
            command: "echo ok".to_string(),
            cwd: temp.path().to_path_buf(),
            policy: policy(temp.path(), other.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        assert!(validate_payload(&mut payload)
            .unwrap_err()
            .contains("selected cwd"));
    }

    #[test]
    fn payload_parent_comparison_uses_windows_path_semantics() {
        assert!(windows_paths_equal(
            Path::new(r"\\?\C:\Users\Student\AppData\Local\Temp"),
            Path::new(r"c:\users\student\appdata\local\temp\")
        ));
        assert!(!windows_paths_equal(
            Path::new(r"C:\Users\Student\AppData\Local\Temp2"),
            Path::new(r"C:\Users\Student\AppData\Local\Temp")
        ));
    }

    #[test]
    fn spawn_failure_cleanup_removes_unconsumed_payload() {
        let temp = tempfile::tempdir().unwrap();
        let payload = WindowsSandboxPayload {
            command: "echo ok".to_string(),
            cwd: temp.path().to_path_buf(),
            policy: policy(temp.path(), temp.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        let payload_path = write_payload(&payload).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.arg(HELPER_ARG).arg(&payload_path);

        PlatformSandboxBackend::new().cleanup_command_resources(&command);

        assert!(!payload_path.exists());
    }

    #[test]
    fn full_access_helper_cwd_stays_at_payload_root() {
        let cwd = tempfile::tempdir().unwrap();
        let backend = UnsandboxedShellBackend::new();
        let mut command = backend
            .command("echo ok", cwd.path(), &policy(cwd.path(), cwd.path()))
            .unwrap();
        let payload_path = payload_path_from_command(&command).unwrap();
        let payload_root = payload_path.parent().unwrap();

        command.env("TEMP", cwd.path()).env("TMP", cwd.path());

        assert!(windows_paths_equal(
            command.as_std().get_current_dir().unwrap(),
            payload_root
        ));
        backend.cleanup_command_resources(&command);
        assert!(!payload_path.exists());
    }

    #[test]
    fn unsandboxed_effect_report_honestly_reports_no_resource_limits() {
        let backend = UnsandboxedShellBackend::new();
        let report = backend.effect_report(&policy(Path::new("C:\\"), Path::new("C:\\")));
        assert_eq!(report.backend, "unsandboxed_job");
        assert!(!report.enforced);
        assert!(!report.network_enforced);
        // relaxed Job 只保留 KILL_ON_JOB_CLOSE（进程树回收），报告不得
        // 宣称存在 CPU/文件大小/进程数资源限制。
        assert_eq!(report.cpu_time_limit_seconds, None);
        assert_eq!(report.file_size_limit_bytes, None);
        assert_eq!(report.active_process_limit, None);
    }

    #[test]
    fn powershell_contract_uses_trusted_binary_encoded_script_and_utf8() {
        let candidates = trusted_powershell_paths().unwrap();
        let powershell = candidates.first().unwrap();
        assert!(powershell.ends_with("pwsh.exe") || powershell.ends_with("powershell.exe"));
        assert!(candidates.last().unwrap().ends_with("powershell.exe"));
        assert!(candidates.len() <= 2);
        if candidates.len() == 2 {
            assert!(candidates[0].ends_with("pwsh.exe"));
            assert!(candidates[1].ends_with("powershell.exe"));
        }

        let command = "Write-Output '中文 output'";
        let encoded = encoded_powershell_command(command);
        let bytes = BASE64.decode(encoded).unwrap();
        let words = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&words).unwrap();
        assert!(script.contains("[Console]::OutputEncoding = $utf8"));
        assert!(script.contains("$OutputEncoding = $utf8"));
        assert!(script.contains(command));
        assert!(script.contains("exit $deepStudentExitCode"));

        let (_application, line) = command_line(command, false, Some(&powershell)).unwrap();
        let line = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(line.contains("-NoProfile -NonInteractive"));
        assert!(line.contains("-EncodedCommand"));
        assert!(!line.to_ascii_uppercase().contains("COMSPEC"));
    }

    #[test]
    fn git_bash_contract_exposes_install_root_and_initializes_path() {
        let bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(
            git_install_root_from_bash(bash),
            Some(PathBuf::from(r"C:\Program Files\Git"))
        );
        assert_eq!(
            git_install_root_from_bash(Path::new(r"C:\Program Files\Git\usr\bin\bash.exe")),
            Some(PathBuf::from(r"C:\Program Files\Git"))
        );

        let (_application, line) =
            command_line("git status --porcelain", true, Some(bash)).unwrap();
        let line = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(line.contains("--noprofile --norc -c"));
        assert!(line.contains("export PATH=\\\"/cmd:/usr/bin:$PATH\\\"; git status --porcelain"));
    }

    #[test]
    fn windows_argv_quoting_preserves_quotes_and_trailing_backslashes() {
        assert_eq!(windows_command_line_arg("plain"), r#""plain""#);
        assert_eq!(windows_command_line_arg("a\"b"), r#""a\"b""#);
        assert_eq!(windows_command_line_arg("a\\"), r#""a\\""#);
    }

    #[test]
    fn job_limits_bound_cpu_and_active_processes() {
        let limits = job_limit_information();
        assert_ne!(
            limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            0
        );
        assert_ne!(
            limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
            0
        );
        assert_ne!(
            limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_PROCESS_TIME,
            0
        );
        assert_eq!(
            limits.BasicLimitInformation.ActiveProcessLimit,
            ACTIVE_PROCESS_LIMIT
        );
        assert_eq!(
            limits.BasicLimitInformation.PerProcessUserTimeLimit,
            PROCESS_CPU_TIME_LIMIT_SECS * 10_000_000
        );
    }

    #[test]
    fn appcontainer_writes_only_inside_selected_cwd() {
        let writable = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inside_file = writable.path().join("inside.txt");
        let outside_file = outside.path().join("outside.txt");
        let command = format!(
            "Set-Content -LiteralPath '{}' -Value inside; Set-Content -LiteralPath '{}' -Value outside",
            inside_file.display(),
            outside_file.display()
        );
        let payload = WindowsSandboxPayload {
            command,
            cwd: writable.path().to_path_buf(),
            policy: policy(writable.path(), writable.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        let _ = run_payload(payload, None).unwrap();
        assert!(inside_file.exists());
        assert!(!outside_file.exists());
    }

    #[test]
    fn appcontainer_blocks_protected_subdirectory_writes() {
        let writable = tempfile::tempdir().unwrap();
        let protected = writable.path().join(".git");
        fs::create_dir(&protected).unwrap();
        let executed = writable.path().join("executed.txt");
        let blocked_file = protected.join("config");
        // Discriminator: a write outside every granted root must be denied by
        // the AppContainer default-deny. If this file appears, the process was
        // not sandboxed at all; if only `blocked_file` appears, the protected
        // root was not sealed out of the sandbox SID's granted namespace.
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("outside.txt");
        let mut sandbox_policy = policy(writable.path(), writable.path());
        sandbox_policy.protected_write_roots.push(protected);
        let payload = WindowsSandboxPayload {
            command: format!(
                "Set-Content -LiteralPath '{}' -Value executed; Set-Content -LiteralPath '{}' -Value blocked; Set-Content -LiteralPath '{}' -Value outside",
                executed.display(),
                blocked_file.display(),
                outside_file.display()
            ),
            cwd: writable.path().to_path_buf(),
            policy: sandbox_policy,
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        let _ = run_payload(payload, None).unwrap();
        assert!(executed.exists());
        assert!(!blocked_file.exists());
        assert!(!outside_file.exists());
    }

    #[test]
    fn appcontainer_denies_network_without_capability() {
        let writable = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let connected = Arc::new(AtomicBool::new(false));
        let connected_for_thread = connected.clone();
        let accept_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok(_) => {
                        connected_for_thread.store(true, Ordering::SeqCst);
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            }
        });
        let payload = WindowsSandboxPayload {
            command: format!("curl.exe --silent --max-time 2 http://127.0.0.1:{port}/ *> $null"),
            cwd: writable.path().to_path_buf(),
            policy: policy(writable.path(), writable.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        let _ = run_payload(payload, None).unwrap();
        accept_thread.join().unwrap();
        assert!(!connected.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_prevents_late_process_launch() {
        let writable = tempfile::tempdir().unwrap();
        let output = writable.path().join("late.txt");
        let event = create_cancellation_event().unwrap();
        assert_ne!(unsafe { SetEvent(event.0) }, 0);
        let payload = WindowsSandboxPayload {
            command: format!(
                "Set-Content -LiteralPath '{}' -Value late",
                output.display()
            ),
            cwd: writable.path().to_path_buf(),
            policy: policy(writable.path(), writable.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
            prefer_git_bash: false,
            shell_path: None,
            fallback_shell_path: None,
        };
        assert_eq!(run_payload(payload, Some(event.0)).unwrap(), 124);
        assert!(!output.exists());
    }
}
