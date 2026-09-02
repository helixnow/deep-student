use std::collections::BTreeSet;
use std::ffi::{c_void, OsStr};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, BOOL, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_ABANDONED_0, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, DENY_ACCESS, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
};
use windows_sys::Win32::Security::{
    DeriveCapabilitySidsFromName, FreeSid, ACL, DACL_SECURITY_INFORMATION, PSID,
    SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
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

use super::{
    configure_stdio, platform_sandbox_contract, PlatformSandboxBackend, SandboxBackend,
    SandboxCapability, SandboxEffectReport, SandboxPolicy, UnsandboxedShellBackend,
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

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[derive(Debug, Serialize, Deserialize)]
struct WindowsSandboxPayload {
    command: String,
    cwd: PathBuf,
    policy: SandboxPolicy,
    profile_name: String,
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
    fn internet_client() -> Result<Self, String> {
        let name = wide("internetClient");
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

fn payload_file() -> PathBuf {
    std::env::temp_dir().join(format!("{PAYLOAD_PREFIX}{}.json", Uuid::new_v4().simple()))
}

fn cleanup_stale_payloads() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
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
    let Ok(temp) = std::env::temp_dir().canonicalize() else {
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
    if canonical.parent() == Some(temp.as_path())
        && name.starts_with(PAYLOAD_PREFIX)
        && name.ends_with(".json")
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = fs::remove_file(canonical);
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
    let path = payload_file();
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
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the Windows temp directory: {error}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve Windows sandbox payload: {error}"))?;
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if canonical.parent() != Some(temp.as_path())
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
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy: policy.clone(),
            profile_name,
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the AppContainer launcher: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(payload_path);
        configure_stdio(&mut command, cwd);
        Ok(command)
    }

    fn cleanup_command_resources(&self, command: &Command) {
        if let Some(path) = payload_path_from_command(command) {
            cleanup_payload_file(&path);
        }
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        let contract = platform_sandbox_contract();
        SandboxEffectReport {
            backend: contract.backend,
            shell_kind: contract.shell_kind,
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
}

impl SandboxBackend for UnsandboxedShellBackend {
    fn capability(&self) -> SandboxCapability {
        match (std::env::current_exe(), trusted_powershell_path()) {
            (Ok(helper), Ok(_)) if helper.is_file() => SandboxCapability::Available,
            (Ok(_), Ok(_)) => SandboxCapability::Unavailable {
                reason: "The current executable is not a regular file".to_string(),
            },
            (Err(error), _) => SandboxCapability::Unavailable {
                reason: format!("Cannot locate the Windows Job Object helper: {error}"),
            },
            (_, Err(reason)) => SandboxCapability::Unavailable { reason },
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
        let payload = WindowsSandboxPayload {
            command: shell_command.to_string(),
            cwd: cwd.to_path_buf(),
            policy: policy.clone(),
            profile_name: format!("{UNSANDBOXED_PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
        };
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the Windows Job Object helper: {error}"))?;
        let payload_path = write_payload(&payload)?;
        let mut command = Command::new(executable);
        command.arg(HELPER_ARG).arg(payload_path);
        configure_stdio(&mut command, cwd);
        Ok(command)
    }

    fn cleanup_command_resources(&self, command: &Command) {
        if let Some(path) = payload_path_from_command(command) {
            cleanup_payload_file(&path);
        }
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "unsandboxed_job",
            shell_kind: "windows_powershell",
            output_encoding: "utf-8",
            enforced: false,
            network_enforced: false,
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

fn grant_policy(policy: &SandboxPolicy, sid: PSID) -> Result<Vec<PathBuf>, String> {
    let read = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let write = read | FILE_GENERIC_WRITE | FILE_DELETE_CHILD | DELETE;
    let mut changed = Vec::new();
    let mut seen = BTreeSet::new();

    let mut apply = |path: &Path, mode: i32, rights: u32| -> Result<(), String> {
        if !path.exists() || !seen.insert((path.to_path_buf(), mode, rights)) {
            return Ok(());
        }
        change_path_acl(path, sid, mode, rights)?;
        changed.push(path.to_path_buf());
        Ok(())
    };

    let is_exposed = |path: &Path| {
        policy
            .readable_roots
            .iter()
            .chain(&policy.writable_roots)
            .any(|root| path.starts_with(root) || root.starts_with(path))
    };

    let result = (|| {
        for path in &policy.readable_roots {
            // Windows and Program Files roots commonly already grant
            // AppContainer read/execute through inherited package ACLs while
            // denying WRITE_DAC to a normal desktop user. A failed redundant
            // read grant must not make every shell command unavailable. Keep
            // write grants and all deny rules fail-closed below.
            if let Err(error) = apply(path, GRANT_ACCESS, read) {
                log::warn!(
                    "[WindowsSandbox] Continuing after optional read ACL grant failed: {}",
                    error
                );
            }
        }
        for path in &policy.writable_roots {
            apply(path, GRANT_ACCESS, write)?;
        }
        for path in &policy.protected_write_roots {
            if is_exposed(path) {
                apply(
                    path,
                    DENY_ACCESS,
                    FILE_GENERIC_WRITE | FILE_DELETE_CHILD | DELETE,
                )?;
            }
        }
        for path in &policy.protected_read_roots {
            if is_exposed(path) {
                apply(path, DENY_ACCESS, write)?;
            }
        }
        Ok(())
    })();

    if let Err(error) = result {
        revoke_policy(&changed, sid);
        return Err(error);
    }
    Ok(changed)
}

fn revoke_policy(paths: &[PathBuf], sid: PSID) {
    let mut unique = BTreeSet::new();
    for path in paths.iter().rev() {
        if unique.insert(path) && path.exists() {
            let _ = change_path_acl(path, sid, REVOKE_ACCESS, 0);
        }
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
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(null(), name.as_ptr()) },
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

fn trusted_powershell_path() -> Result<PathBuf, String> {
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

fn encoded_powershell_command(command: &str) -> String {
    let script = format!(
        "$utf8 = [System.Text.UTF8Encoding]::new($false)\n\
         try {{ [Console]::InputEncoding = $utf8 }} catch {{}}\n\
         try {{ [Console]::OutputEncoding = $utf8 }} catch {{}}\n\
         $OutputEncoding = $utf8\n\
         $ProgressPreference = 'SilentlyContinue'\n\
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

fn command_line(command: &str) -> Result<(Vec<u16>, Vec<u16>), String> {
    let powershell = trusted_powershell_path()?;
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
        return run_unsandboxed_job_process(&payload, cancellation_event);
    }
    let Some(_acl_guard) = acquire_acl_mutex(cancellation_event)? else {
        return Ok(124);
    };
    if is_cancelled(cancellation_event) {
        return Ok(124);
    }
    let capability_allocation = payload
        .policy
        .allow_network
        .then(CapabilityAllocation::internet_client)
        .transpose()?;
    let capabilities = capability_allocation
        .as_ref()
        .map(CapabilityAllocation::attributes)
        .unwrap_or_default();
    let profile = create_profile(&payload.profile_name, &capabilities)?;
    let changed_paths = grant_policy(&payload.policy, profile.sid)?;
    let result = if is_cancelled(cancellation_event) {
        Ok(124)
    } else {
        run_appcontainer_process(&payload, profile.sid, &capabilities, cancellation_event)
    };
    revoke_policy(&changed_paths, profile.sid);
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

    let (application, mut command_line) = command_line(&payload.command)?;
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

    let (application, mut command_line) = command_line(&payload.command)?;
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
        };
        assert!(validate_payload(&mut payload)
            .unwrap_err()
            .contains("selected cwd"));
    }

    #[test]
    fn spawn_failure_cleanup_removes_unconsumed_payload() {
        let temp = tempfile::tempdir().unwrap();
        let payload = WindowsSandboxPayload {
            command: "echo ok".to_string(),
            cwd: temp.path().to_path_buf(),
            policy: policy(temp.path(), temp.path()),
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
        };
        let payload_path = write_payload(&payload).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.arg(HELPER_ARG).arg(&payload_path);

        PlatformSandboxBackend::new().cleanup_command_resources(&command);

        assert!(!payload_path.exists());
    }

    #[test]
    fn powershell_contract_uses_trusted_binary_encoded_script_and_utf8() {
        let powershell = trusted_powershell_path().unwrap();
        assert!(powershell.ends_with(
            Path::new("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        ));

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

        let (_application, line) = command_line(command).unwrap();
        let line = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(line.contains("-NoProfile -NonInteractive"));
        assert!(line.contains("-EncodedCommand"));
        assert!(!line.to_ascii_uppercase().contains("COMSPEC"));
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
        let blocked_file = protected.join("config");
        let mut sandbox_policy = policy(writable.path(), writable.path());
        sandbox_policy.protected_write_roots.push(protected);
        let payload = WindowsSandboxPayload {
            command: format!(
                "Set-Content -LiteralPath '{}' -Value blocked",
                blocked_file.display()
            ),
            cwd: writable.path().to_path_buf(),
            policy: sandbox_policy,
            profile_name: format!("{PROFILE_PREFIX}{}", Uuid::new_v4().simple()),
        };
        let _ = run_payload(payload, None).unwrap();
        assert!(!blocked_file.exists());
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
        };
        assert_eq!(run_payload(payload, Some(event.0)).unwrap(), 124);
        assert!(!output.exists());
    }
}
