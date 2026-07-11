use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

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
    pub enforced: bool,
    pub network_enforced: bool,
    pub process_group_isolated: bool,
    pub readable_roots: usize,
    pub writable_roots: usize,
    pub protected_read_roots: usize,
    pub protected_write_roots: usize,
}

pub trait SandboxBackend: Send + Sync {
    fn capability(&self) -> SandboxCapability;
    fn command(
        &self,
        shell_command: &str,
        cwd: &Path,
        policy: &SandboxPolicy,
    ) -> Result<Command, String>;
    fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport;
}

pub struct PlatformSandboxBackend;

impl PlatformSandboxBackend {
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
fn isolate_process_group(command: &mut Command) {
    // SAFETY: setpgid is async-signal-safe and the closure performs no allocation.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut Command) {}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

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
            let mut command = Command::new(SANDBOX_EXEC);
            command.args(["-p", &profile, "/bin/sh", "-c", shell_command]);
            configure_stdio(&mut command, cwd);
            isolate_process_group(&mut command);
            Ok(command)
        }

        fn effect_report(&self, policy: &SandboxPolicy) -> SandboxEffectReport {
            SandboxEffectReport {
                backend: "macos_seatbelt",
                enforced: matches!(self.capability(), SandboxCapability::Available),
                network_enforced: true,
                process_group_isolated: true,
                readable_roots: policy.readable_roots.len(),
                writable_roots: policy.writable_roots.len(),
                protected_read_roots: policy.protected_read_roots.len(),
                protected_write_roots: policy.protected_write_roots.len(),
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
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
        SandboxEffectReport {
            backend: "unavailable",
            enforced: false,
            network_enforced: false,
            process_group_isolated: false,
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::macos::profile;
    use super::*;
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
        let output = backend
            .command(script, temp.path(), &policy)
            .unwrap()
            .output()
            .await
            .unwrap();
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
        let status = backend
            .command(&script, temp.path(), &policy)
            .unwrap()
            .spawn()
            .unwrap()
            .wait()
            .await
            .unwrap();
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
        let mut child = backend
            .command(
                "sleep 30 & echo $! > descendant.pid; wait",
                temp.path(),
                &policy,
            )
            .unwrap()
            .spawn()
            .unwrap();
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
}
