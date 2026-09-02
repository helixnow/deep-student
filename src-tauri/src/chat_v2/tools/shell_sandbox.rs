use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

const SANDBOX_CPU_TIME_LIMIT_SECS: u64 = 130;
const SANDBOX_FILE_SIZE_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
// RLIMIT_NPROC is per-user on macOS rather than per process tree. Keep the ceiling high enough
// for a busy desktop session while still preventing an unbounded fork storm.
const SANDBOX_PROCESS_LIMIT: u32 = 2_048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPolicy {
    pub readable_roots: Vec<PathBuf>,
    pub writable_roots: Vec<PathBuf>,
    pub protected_read_roots: Vec<PathBuf>,
    pub protected_write_roots: Vec<PathBuf>,
    pub allow_network: bool,
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::maybe_run_helper;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxCapability {
    Available,
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SandboxEffectReport {
    pub backend: &'static str,
    pub shell_kind: &'static str,
    pub output_encoding: &'static str,
    pub enforced: bool,
    pub network_enforced: bool,
    pub process_group_isolated: bool,
    pub cpu_time_limit_seconds: Option<u64>,
    pub file_size_limit_bytes: Option<u64>,
    pub active_process_limit: Option<u32>,
    pub readable_roots: usize,
    pub writable_roots: usize,
    pub protected_read_roots: usize,
    pub protected_write_roots: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SandboxRuntimeContract {
    pub backend: &'static str,
    pub shell_kind: &'static str,
    pub output_encoding: &'static str,
}

pub(crate) const fn platform_sandbox_contract() -> SandboxRuntimeContract {
    #[cfg(target_os = "macos")]
    {
        SandboxRuntimeContract {
            backend: "macos_seatbelt",
            shell_kind: "posix_sh",
            output_encoding: "utf-8",
        }
    }

    #[cfg(windows)]
    {
        SandboxRuntimeContract {
            backend: "windows_appcontainer_job",
            shell_kind: "windows_powershell",
            output_encoding: "utf-8",
        }
    }

    // Linux 桌面使用 bubblewrap（bwrap）沙箱。注意：Android 的 target_os 是
    // "android" 而非 "linux"，因此本分支不会在移动端命中，Android 仍然落入
    // 下方 fail-closed 的 "unavailable" 契约。
    #[cfg(target_os = "linux")]
    {
        SandboxRuntimeContract {
            backend: "linux_bwrap",
            shell_kind: "posix_sh",
            output_encoding: "utf-8",
        }
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        SandboxRuntimeContract {
            backend: "unavailable",
            shell_kind: "unavailable",
            output_encoding: "unknown",
        }
    }
}

pub trait SandboxBackend: Send + Sync {
    fn capability(&self) -> SandboxCapability;
    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String>;
    fn cleanup_command_resources(&self, _command: &Command) {}
    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport;
}

pub struct PlatformSandboxBackend;
/// Explicit backend used by backend-authorized full-access Craft presets. It
/// removes filesystem/network sandbox
/// boundaries but intentionally retains process-group isolation, resource
/// limits, bounded output, timeout/cancellation cleanup and env filtering.
pub struct UnsandboxedShellBackend;

impl Default for PlatformSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformSandboxBackend {
    pub fn new() -> Self {
        Self
    }
}

impl UnsandboxedShellBackend {
    pub fn new() -> Self {
        Self
    }
}

fn configure_stdio(command: &mut Command, cwd: &Path) {
    command
        .kill_on_drop(true)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
}

#[cfg(unix)]
fn isolate_process_group(command: &mut Command, with_resource_limits: bool) {
    // SAFETY: setpgid/setrlimit are async-signal-safe and the closure performs no allocation.
    // 完全信任（unsandboxed）通道只保留 setpgid 进程组隔离（用于取消时清理
    // 进程树），不施加 RLIMIT——npm install 等长任务不应被 130s CPU 上限强杀。
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if !with_resource_limits {
                return Ok(());
            }
            let cpu_limit = libc::rlimit {
                rlim_cur: SANDBOX_CPU_TIME_LIMIT_SECS as libc::rlim_t,
                rlim_max: SANDBOX_CPU_TIME_LIMIT_SECS as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_CPU, &cpu_limit) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let file_size_limit = libc::rlimit {
                rlim_cur: SANDBOX_FILE_SIZE_LIMIT_BYTES as libc::rlim_t,
                rlim_max: SANDBOX_FILE_SIZE_LIMIT_BYTES as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &file_size_limit) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let process_limit = libc::rlimit {
                rlim_cur: SANDBOX_PROCESS_LIMIT as libc::rlim_t,
                rlim_max: SANDBOX_PROCESS_LIMIT as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_NPROC, &process_limit) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut Command, _with_resource_limits: bool) {}

#[cfg(unix)]
impl SandboxBackend for UnsandboxedShellBackend {
    fn capability(&self) -> SandboxCapability {
        match std::fs::metadata("/bin/sh") {
            Ok(metadata) if metadata.is_file() => SandboxCapability::Available,
            Ok(_) => SandboxCapability::Unavailable {
                reason: "/bin/sh is not a regular file".to_string(),
            },
            Err(error) => SandboxCapability::Unavailable {
                reason: format!("/bin/sh is unavailable: {error}"),
            },
        }
    }

    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        _policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        if let SandboxCapability::Unavailable { reason } = self.capability() {
            return Err(format!(
                "Full Access shell backend is unavailable: {reason}"
            ));
        }
        let mut command = Command::new("/bin/sh");
        command.args(["-c", shell_command]);
        configure_stdio(&mut command, cwd);
        isolate_process_group(&mut command, false);
        Ok(command)
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "unsandboxed",
            shell_kind: "posix_sh",
            output_encoding: "utf-8",
            enforced: false,
            network_enforced: false,
            process_group_isolated: true,
            // 完全信任通道不施加 RLIMIT（CPU/文件大小/进程数均不设限）。
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

#[cfg(not(any(unix, windows)))]
impl SandboxBackend for UnsandboxedShellBackend {
    fn capability(&self) -> SandboxCapability {
        SandboxCapability::Unavailable {
            reason: "No danger-full-access shell backend is implemented for this platform"
                .to_string(),
        }
    }

    fn command(
        &self,
        _shell_command: &str,
        _cwd: &Path,
        _policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        Err("Full Access shell backend is unavailable".to_string())
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        SandboxEffectReport {
            backend: "unsandboxed_unavailable",
            shell_kind: "unavailable",
            output_encoding: "unknown",
            enforced: false,
            network_enforced: false,
            process_group_isolated: false,
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

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::OsStr;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    const PROFILE_FILE_PREFIX: &str = "deep-student-seatbelt-";
    const STALE_PROFILE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

    fn cleanup_stale_profile_files() {
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if !name.starts_with(PROFILE_FILE_PREFIX) || !name.ends_with(".sb") {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let is_stale = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= STALE_PROFILE_AGE);
            if is_stale {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn write_profile_file(contents: &str) -> Result<PathBuf, String> {
        cleanup_stale_profile_files();
        let mut profile = tempfile::Builder::new()
            .prefix(PROFILE_FILE_PREFIX)
            .suffix(".sb")
            .tempfile_in(std::env::temp_dir())
            .map_err(|error| format!("Failed to create macOS Seatbelt profile: {error}"))?;
        profile
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure macOS Seatbelt profile: {error}"))?;
        profile
            .write_all(contents.as_bytes())
            .and_then(|_| profile.as_file().sync_all())
            .map_err(|error| format!("Failed to persist macOS Seatbelt profile: {error}"))?;
        let (_file, path) = profile
            .keep()
            .map_err(|error| format!("Failed to retain macOS Seatbelt profile: {error}"))?;
        Ok(path)
    }

    fn profile_path_from_command(command: &Command) -> Option<PathBuf> {
        let mut args = command.as_std().get_args();
        while let Some(argument) = args.next() {
            if argument == OsStr::new("-f") {
                return args.next().map(PathBuf::from);
            }
        }
        None
    }

    fn cleanup_profile_file(command: &Command) {
        let Some(path) = profile_path_from_command(command) else {
            return;
        };
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            return;
        };
        if path.parent() == Some(std::env::temp_dir().as_path())
            && name.starts_with(PROFILE_FILE_PREFIX)
            && name.ends_with(".sb")
        {
            let _ = std::fs::remove_file(path);
        }
    }

    fn seatbelt_literal(path: &Path) -> Result<String, String> {
        let canonical = path.canonicalize().map_err(|error| {
            format!(
                "Failed to canonicalize sandbox policy path '{}': {error}",
                path.display()
            )
        })?;
        let raw = canonical.to_string_lossy();
        let escaped = raw.replace('\\', "\\\\").replace('"', "\\\"");
        Ok(format!("\"{escaped}\""))
    }

    fn subpath_rule(operation: &str, path: &Path) -> Result<String, String> {
        Ok(format!(
            "({operation} (subpath {}))",
            seatbelt_literal(path)?
        ))
    }

    fn literal_rule(operation: &str, path: &str) -> String {
        format!("({operation} (literal \"{path}\"))")
    }

    pub(super) fn profile(policy: &SandboxPolicy) -> Result<String, String> {
        let mut rules = vec![
            "(version 1)".to_string(),
            "(deny default)".to_string(),
            "(import \"system.sb\")".to_string(),
            "(allow process*)".to_string(),
            "(allow signal (target self))".to_string(),
            "(allow signal (target children))".to_string(),
            "(allow sysctl-read)".to_string(),
            "(deny mach-lookup)".to_string(),
            "(allow file-read-metadata)".to_string(),
        ];

        for path in ["/System", "/usr", "/bin", "/sbin", "/Library/Apple"] {
            rules.push(format!("(allow file-read* (subpath \"{path}\"))"));
        }
        for path in [
            "/private/etc",
            "/private/var/db/timezone",
            "/dev/null",
            "/dev/zero",
            "/dev/random",
            "/dev/urandom",
        ] {
            rules.push(if path.starts_with("/dev/") {
                literal_rule("allow file-read*", path)
            } else {
                format!("(allow file-read* (subpath \"{path}\"))")
            });
        }

        for root in &policy.readable_roots {
            rules.push(subpath_rule("allow file-read*", root)?);
        }
        for root in &policy.writable_roots {
            rules.push(subpath_rule("allow file-read*", root)?);
            rules.push(subpath_rule("allow file-write*", root)?);
        }
        for root in &policy.protected_write_roots {
            if root.exists() {
                rules.push(subpath_rule("deny file-write*", root)?);
            }
        }
        for root in &policy.protected_read_roots {
            if root.exists() {
                rules.push(subpath_rule("deny file-read*", root)?);
            }
        }

        if policy.allow_network {
            rules.push("(allow network*)".to_string());
        } else {
            rules.push("(deny network*)".to_string());
        }

        Ok(rules.join("\n"))
    }

    impl SandboxBackend for PlatformSandboxBackend {
        fn capability(&self) -> SandboxCapability {
            match std::fs::metadata(SANDBOX_EXEC) {
                Ok(metadata) if metadata.is_file() => SandboxCapability::Available,
                Ok(_) => SandboxCapability::Unavailable {
                    reason: format!("{SANDBOX_EXEC} is not a regular file"),
                },
                Err(error) => SandboxCapability::Unavailable {
                    reason: format!("macOS Seatbelt launcher is unavailable: {error}"),
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
            let profile = profile(policy)?;
            let profile_path = write_profile_file(&profile)?;
            let mut command = Command::new(SANDBOX_EXEC);
            command
                .arg("-f")
                .arg(profile_path)
                .args(["/bin/sh", "-c", shell_command]);
            configure_stdio(&mut command, cwd);
            isolate_process_group(&mut command, true);
            Ok(command)
        }

        fn cleanup_command_resources(&self, command: &Command) {
            cleanup_profile_file(command);
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
                cpu_time_limit_seconds: Some(SANDBOX_CPU_TIME_LIMIT_SECS),
                file_size_limit_bytes: Some(SANDBOX_FILE_SIZE_LIMIT_BYTES),
                active_process_limit: Some(SANDBOX_PROCESS_LIMIT),
                readable_roots: policy.readable_roots.len(),
                writable_roots: policy.writable_roots.len(),
                protected_read_roots: policy.protected_read_roots.len(),
                protected_write_roots: policy.protected_write_roots.len(),
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::ffi::OsString;

    /// 发行版包管理器安装 bubblewrap 后 bwrap 的常见落点；先探测这些
    /// 固定路径，再回退到 PATH 逐目录查找（不经 shell，避免注入面）。
    const BWRAP_CANDIDATES: &[&str] = &["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

    pub(super) fn locate_bwrap() -> Result<PathBuf, String> {
        for candidate in BWRAP_CANDIDATES {
            let path = Path::new(candidate);
            if path.is_file() {
                return Ok(path.to_path_buf());
            }
        }
        if let Some(path_value) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_value) {
                if dir.as_os_str().is_empty() || !dir.is_absolute() {
                    continue;
                }
                let candidate = dir.join("bwrap");
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        Err(
            "Linux bubblewrap launcher (bwrap) was not found; install the 'bubblewrap' package \
             to enable the local shell sandbox"
                .to_string(),
        )
    }

    fn canonical_policy_path(path: &Path) -> Result<PathBuf, String> {
        path.canonicalize().map_err(|error| {
            format!(
                "Failed to canonicalize sandbox policy path '{}': {error}",
                path.display()
            )
        })
    }

    /// 构造 bwrap 参数向量。bwrap 按参数顺序处理挂载，后面的挂载会覆盖
    /// 前面的，因此顺序即语义：
    /// 1. 整个根文件系统只读 bind（读边界比 macOS Seatbelt 宽，敏感路径由
    ///    下方 protected_* 遮蔽补齐）；
    /// 2. /dev、/proc 换成沙箱私有实例；
    /// 3. policy 允许写的 roots 重新挂成可写；
    /// 4. protected_write_roots 再压回只读（覆盖可写挂载内部的保护子树，
    ///    如 .git、技能包目录）；
    /// 5. protected_read_roots 用 tmpfs（目录）或 /dev/null bind（文件）
    ///    遮蔽，读写都不可达真实内容——对应 macOS 的 deny file-read*。
    ///
    /// 参数直接进 exec 数组、不经 shell，路径含空格/特殊字符无需转义。
    pub(super) fn bwrap_args(
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Vec<OsString>, String> {
        let mut args: Vec<OsString> = Vec::new();
        args.push("--ro-bind".into());
        args.push("/".into());
        args.push("/".into());
        args.push("--dev".into());
        args.push("/dev".into());
        args.push("--proc".into());
        args.push("/proc".into());

        for root in &policy.writable_roots {
            let canonical = canonical_policy_path(root)?;
            args.push("--bind".into());
            args.push(canonical.clone().into_os_string());
            args.push(canonical.into_os_string());
        }
        for root in &policy.protected_write_roots {
            if !root.exists() {
                continue;
            }
            let canonical = canonical_policy_path(root)?;
            args.push("--ro-bind".into());
            args.push(canonical.clone().into_os_string());
            args.push(canonical.into_os_string());
        }
        for root in &policy.protected_read_roots {
            if !root.exists() {
                continue;
            }
            let canonical = canonical_policy_path(root)?;
            if canonical.is_dir() {
                args.push("--tmpfs".into());
                args.push(canonical.into_os_string());
            } else {
                // tmpfs 只能挂在目录上；文件型敏感路径（如 .netrc）用
                // /dev/null 覆盖 bind，读到的内容恒为空。
                args.push("--ro-bind".into());
                args.push("/dev/null".into());
                args.push(canonical.into_os_string());
            }
        }

        if !policy.allow_network {
            args.push("--unshare-net".into());
        }
        args.push("--unshare-pid".into());
        args.push("--die-with-parent".into());
        // --new-session 隔离控制终端，封堵 TIOCSTI 注入宿主终端输入的路径
        args.push("--new-session".into());
        args.push("--chdir".into());
        args.push(cwd.as_os_str().to_os_string());

        args.push("/bin/sh".into());
        args.push("-c".into());
        args.push(shell_command.into());
        Ok(args)
    }

    impl SandboxBackend for PlatformSandboxBackend {
        fn capability(&self) -> SandboxCapability {
            match locate_bwrap() {
                Ok(_) => SandboxCapability::Available,
                Err(reason) => SandboxCapability::Unavailable { reason },
            }
        }

        fn command(
            &self,
            shell_command: &str,
            cwd: &Path,
            policy: &SandboxPolicy,
        ) -> Result<Command, String> {
            let bwrap = match locate_bwrap() {
                Ok(path) => path,
                Err(reason) => {
                    return Err(format!(
                        "Local shell sandbox is unavailable; refusing unsandboxed execution: {reason}"
                    ));
                }
            };
            let args = bwrap_args(shell_command, cwd, policy)?;
            let mut command = Command::new(bwrap);
            command.args(args);
            configure_stdio(&mut command, cwd);
            isolate_process_group(&mut command, true);
            Ok(command)
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
                cpu_time_limit_seconds: Some(SANDBOX_CPU_TIME_LIMIT_SECS),
                file_size_limit_bytes: Some(SANDBOX_FILE_SIZE_LIMIT_BYTES),
                active_process_limit: Some(SANDBOX_PROCESS_LIMIT),
                readable_roots: policy.readable_roots.len(),
                writable_roots: policy.writable_roots.len(),
                protected_read_roots: policy.protected_read_roots.len(),
                protected_write_roots: policy.protected_write_roots.len(),
            }
        }
    }
}

// 其余平台（含 Android，其 target_os 为 "android" 而非 "linux"）没有
// 硬沙箱后端，保持 fail-closed。
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl SandboxBackend for PlatformSandboxBackend {
    fn capability(&self) -> SandboxCapability {
        SandboxCapability::Unavailable {
            reason: "No hard local-shell sandbox backend is implemented for this platform"
                .to_string(),
        }
    }

    fn command(
        &self,
        _shell_command: &str,
        _cwd: &Path,
        _policy: &SandboxPolicy,
    ) -> Result<Command, String> {
        Err("Local shell sandbox is unavailable; refusing unsandboxed execution".to_string())
    }

    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
        let contract = platform_sandbox_contract();
        SandboxEffectReport {
            backend: contract.backend,
            shell_kind: contract.shell_kind,
            output_encoding: contract.output_encoding,
            enforced: false,
            network_enforced: false,
            process_group_isolated: false,
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

pub fn terminate_process_group(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = child
            .id()
            .ok_or_else(|| "Sandboxed shell process has no process id".to_string())?;
        let result = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "Failed to terminate sandbox process group: {error}"
                ));
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    {
        windows::terminate_job_for_child(child)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = child;
        Err("Process-group termination is unavailable on this platform".to_string())
    }
}

/// Clean up descendants after the foreground launcher has already been reaped.
///
/// Tokio clears `Child::id()` after `wait()`, but on Unix the original PID remains the process
/// group id for any background descendants. Windows' helper owns a kill-on-close Job Object and
/// does not exit until ACL/Profile cleanup is complete, so a successfully reaped helper needs no
/// additional action here.
pub fn cleanup_finished_process_group(process_id: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(process_id as libc::pid_t), libc::SIGKILL) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "Failed to clean up sandbox background process group: {error}"
                ));
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    {
        let _ = process_id;
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = process_id;
        Err("Process-group cleanup is unavailable on this platform".to_string())
    }
}

/// 纯参数构造的单元测试：只校验 bwrap 参数向量与 effect report 的语义，
/// 不真正执行 bwrap（CI 环境可能未安装 bubblewrap）。
#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::linux::bwrap_args;
    use super::*;
    use std::ffi::OsString;

    fn os(value: &str) -> OsString {
        OsString::from(value)
    }

    /// 在参数向量中查找连续的一段参数是否存在
    fn contains_sequence(args: &[OsString], expected: &[OsString]) -> bool {
        args.windows(expected.len())
            .any(|window| window == expected)
    }

    #[test]
    fn bwrap_args_readonly_root_and_writable_remount_and_no_network() {
        let temp = tempfile::tempdir().unwrap();
        let writable = temp.path().join("writable");
        let protected = writable.join(".git");
        std::fs::create_dir_all(&protected).unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![writable.clone()],
            protected_read_roots: vec![],
            protected_write_roots: vec![protected.clone()],
            allow_network: false,
        };
        let args = bwrap_args("printf ok", &writable, &policy).unwrap();

        assert_eq!(args[..3], [os("--ro-bind"), os("/"), os("/")]);
        assert!(contains_sequence(&args, &[os("--dev"), os("/dev")]));
        assert!(contains_sequence(&args, &[os("--proc"), os("/proc")]));
        let writable_canon = writable.canonicalize().unwrap();
        assert!(contains_sequence(
            &args,
            &[
                os("--bind"),
                writable_canon.clone().into_os_string(),
                writable_canon.into_os_string(),
            ]
        ));
        let protected_canon = protected.canonicalize().unwrap();
        assert!(contains_sequence(
            &args,
            &[
                os("--ro-bind"),
                protected_canon.clone().into_os_string(),
                protected_canon.into_os_string(),
            ]
        ));
        assert!(args.contains(&os("--unshare-net")));
        assert!(args.contains(&os("--unshare-pid")));
        assert!(args.contains(&os("--die-with-parent")));
        assert!(args.contains(&os("--new-session")));
        assert_eq!(
            args[args.len() - 3..],
            [os("/bin/sh"), os("-c"), os("printf ok")]
        );
    }

    #[test]
    fn bwrap_args_allow_network_omits_unshare_net() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: true,
        };
        let args = bwrap_args("printf ok", temp.path(), &policy).unwrap();
        assert!(!args.contains(&os("--unshare-net")));
        assert!(args.contains(&os("--unshare-pid")));
    }

    #[test]
    fn bwrap_args_mask_protected_read_dirs_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let secret_dir = temp.path().join(".ssh");
        let secret_file = temp.path().join(".netrc");
        std::fs::create_dir_all(&secret_dir).unwrap();
        std::fs::write(&secret_file, b"secret").unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![],
            protected_read_roots: vec![secret_dir.clone(), secret_file.clone()],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let args = bwrap_args("printf ok", temp.path(), &policy).unwrap();
        assert!(contains_sequence(
            &args,
            &[
                os("--tmpfs"),
                secret_dir.canonicalize().unwrap().into_os_string(),
            ]
        ));
        assert!(contains_sequence(
            &args,
            &[
                os("--ro-bind"),
                os("/dev/null"),
                secret_file.canonicalize().unwrap().into_os_string(),
            ]
        ));
    }

    #[test]
    fn bwrap_args_pass_paths_with_spaces_verbatim() {
        let temp = tempfile::tempdir().unwrap();
        let spaced = temp.path().join("dir with spaces");
        std::fs::create_dir_all(&spaced).unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![spaced.clone()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let spaced_canon = spaced.canonicalize().unwrap();
        let args = bwrap_args("printf ok", &spaced_canon, &policy).unwrap();
        // 路径直接进 exec 数组，不做任何 shell 转义
        assert!(args.contains(&spaced_canon.clone().into_os_string()));
        assert!(contains_sequence(
            &args,
            &[os("--chdir"), spaced_canon.into_os_string()]
        ));
    }

    #[test]
    fn effect_report_exposes_resource_limits_and_contract() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let report = PlatformSandboxBackend::new().effect_report(&policy);
        assert_eq!(report.backend, "linux_bwrap");
        assert_eq!(report.shell_kind, "posix_sh");
        assert_eq!(report.output_encoding, "utf-8");
        assert!(report.network_enforced);
        assert!(report.process_group_isolated);
        assert_eq!(
            report.cpu_time_limit_seconds,
            Some(SANDBOX_CPU_TIME_LIMIT_SECS)
        );
        assert_eq!(
            report.file_size_limit_bytes,
            Some(SANDBOX_FILE_SIZE_LIMIT_BYTES)
        );
        assert_eq!(report.active_process_limit, Some(SANDBOX_PROCESS_LIMIT));
        assert_eq!(report.readable_roots, 1);
        assert_eq!(report.writable_roots, 1);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::macos::profile;
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    #[test]
    fn profile_denies_network_and_protects_write_roots() {
        let temp = tempfile::tempdir().unwrap();
        let readable = temp.path().join("readable");
        let writable = temp.path().join("writable");
        let protected = writable.join("protected");
        std::fs::create_dir_all(&readable).unwrap();
        std::fs::create_dir_all(&protected).unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![readable.clone()],
            writable_roots: vec![writable.clone()],
            protected_read_roots: vec![],
            protected_write_roots: vec![protected.clone()],
            allow_network: false,
        };
        let rendered = profile(&policy).unwrap();
        assert!(rendered.contains("(deny network*)"));
        assert!(rendered.contains("(allow file-write*"));
        assert!(rendered.contains("(deny file-write*"));
        assert!(rendered.contains(&readable.to_string_lossy().to_string()));

        let report = PlatformSandboxBackend::new().effect_report(&policy);
        assert_eq!(
            report.cpu_time_limit_seconds,
            Some(SANDBOX_CPU_TIME_LIMIT_SECS)
        );
        assert_eq!(
            report.file_size_limit_bytes,
            Some(SANDBOX_FILE_SIZE_LIMIT_BYTES)
        );
        assert_eq!(report.active_process_limit, Some(SANDBOX_PROCESS_LIMIT));
    }

    #[tokio::test]
    async fn seatbelt_blocks_write_outside_writable_roots() {
        let temp = tempfile::tempdir().unwrap();
        let allowed = temp.path().join("allowed");
        let blocked = temp.path().join("blocked");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&blocked).unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![allowed.clone()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let command_text = format!("printf blocked > '{}/escape.txt'", blocked.display());
        let mut command = backend.command(&command_text, &allowed, &policy).unwrap();
        let status = command.spawn().unwrap().wait().await.unwrap();
        backend.cleanup_command_resources(&command);
        assert!(!status.success());
        assert!(!blocked.join("escape.txt").exists());
    }

    #[tokio::test]
    async fn seatbelt_allows_shell_operators_interpreters_and_children_inside_root() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let script =
            "sh -c 'printf child > child.txt' && awk 'BEGIN { print \"awk\" }' > interpreter.txt";
        let mut command = backend.command(script, temp.path(), &policy).unwrap();
        let output = command.output().await.unwrap();
        backend.cleanup_command_resources(&command);
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("child.txt")).unwrap(),
            "child"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("interpreter.txt")).unwrap(),
            "awk\n"
        );
    }

    #[tokio::test]
    async fn seatbelt_allows_script_runner_while_network_is_denied() {
        let temp = tempfile::tempdir().unwrap();
        let developer_dir = std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
            .filter(|path| path.is_dir());
        let developer_root = developer_dir.clone().map(|mut selected| {
            if selected.ends_with(Path::new("Contents").join("Developer")) {
                selected = selected.parent().unwrap().parent().unwrap().to_path_buf();
            }
            selected
        });
        let mut readable_roots = vec![temp.path().to_path_buf()];
        if let Some(developer_root) = developer_root {
            readable_roots.push(developer_root);
        }
        let policy = SandboxPolicy {
            readable_roots,
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let mut command = backend
            .command(
                "python3 -c 'print(\"offline-runner-ok\")'",
                temp.path(),
                &policy,
            )
            .unwrap();
        command
            .env("TMPDIR", temp.path())
            .env("TEMP", temp.path())
            .env("TMP", temp.path());
        if let Some(developer_dir) = developer_dir {
            let developer_bin = developer_dir.join("usr/bin");
            command.env("DEVELOPER_DIR", &developer_dir);
            if developer_bin.is_dir() {
                let mut paths = vec![developer_bin];
                if let Some(current_path) = std::env::var_os("PATH") {
                    paths.extend(std::env::split_paths(&current_path));
                }
                command.env("PATH", std::env::join_paths(paths).unwrap());
            }
        }
        let output = command.output().await.unwrap();
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"offline-runner-ok\n");
    }

    #[tokio::test]
    async fn seatbelt_denies_network_even_to_loopback() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let script = format!("nc -G 1 -z 127.0.0.1 {port}");
        let mut command = backend.command(&script, temp.path(), &policy).unwrap();
        let status = command.spawn().unwrap().wait().await.unwrap();
        backend.cleanup_command_resources(&command);
        assert!(!status.success());
        drop(listener);
    }

    #[tokio::test]
    async fn timeout_kills_descendant_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let mut command = backend
            .command(
                "sleep 30 & echo $! > descendant.pid; wait",
                temp.path(),
                &policy,
            )
            .unwrap();
        let mut child = command.spawn().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if temp.path().join("descendant.pid").exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let descendant_pid: libc::pid_t =
            std::fs::read_to_string(temp.path().join("descendant.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        terminate_process_group(&mut child).unwrap();
        child.wait().await.unwrap();
        backend.cleanup_command_resources(&command);

        let gone = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let result = unsafe { libc::kill(descendant_pid, 0) };
                if result == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            gone.is_ok(),
            "descendant process survived process-group kill"
        );
    }

    #[test]
    fn seatbelt_profile_is_private_temp_file_and_not_inline_argv() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![temp.path().to_path_buf()],
            writable_roots: vec![temp.path().to_path_buf()],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: false,
        };
        let backend = PlatformSandboxBackend::new();
        let command = backend
            .command("printf ok", temp.path(), &policy)
            .expect("seatbelt command");
        let args = command.as_std().get_args().collect::<Vec<_>>();
        let profile_index = args
            .iter()
            .position(|argument| *argument == OsStr::new("-f"))
            .expect("sandbox-exec should use a profile file");
        let profile_path = PathBuf::from(args[profile_index + 1]);
        let metadata = std::fs::metadata(&profile_path).expect("profile metadata");

        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(&profile_path)
            .unwrap()
            .contains("(deny default)"));
        assert!(!args
            .iter()
            .any(|argument| argument.to_string_lossy().contains("(deny default)")));

        backend.cleanup_command_resources(&command);
        assert!(!profile_path.exists());
    }

    #[test]
    fn danger_backend_is_explicit_unsandboxed_posix_shell_with_limits() {
        let temp = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            readable_roots: vec![],
            writable_roots: vec![],
            protected_read_roots: vec![],
            protected_write_roots: vec![],
            allow_network: true,
        };
        let backend = UnsandboxedShellBackend::new();
        let command = backend
            .command("printf ok", temp.path(), &policy)
            .expect("danger backend command");
        assert_eq!(command.as_std().get_program(), OsStr::new("/bin/sh"));
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            vec![OsStr::new("-c"), OsStr::new("printf ok")]
        );
        let report = backend.effect_report(&policy);
        assert_eq!(report.backend, "unsandboxed");
        assert!(!report.enforced);
        assert!(!report.network_enforced);
        assert!(report.process_group_isolated);
        // 完全信任通道不施加 RLIMIT 资源上限
        assert_eq!(report.cpu_time_limit_seconds, None);
        assert_eq!(report.file_size_limit_bytes, None);
        assert_eq!(report.active_process_limit, None);
    }
}
