// 包管理器检测和自动安装模块
// 支持 npm/npx、uv、pip、cargo等常见包管理器

use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// N12（2026-09-07 审阅）：安装子进程的总 deadline。安装脚本可能走网络，
/// 挂起时不能无限占据 runtime。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 每个输出流（stdout/stderr）的保留上限；超出的部分继续读但丢弃，
/// 既防内存放大又不让子进程因管道满而卡住。
const MAX_INSTALL_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageManagerInfo {
    pub manager_type: String,
    pub is_available: bool,
    pub version: Option<String>,
    pub install_command: Option<String>,
    pub install_hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageInstallResult {
    pub success: bool,
    pub message: String,
    pub installed_version: Option<String>,
}

/// 检测命令是否可用
fn is_command_available(command: &str) -> bool {
    let result = if cfg!(target_os = "windows") {
        Command::new("where").arg(command).output()
    } else {
        Command::new("which").arg(command).output()
    };

    match result {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// 获取命令版本
fn get_command_version(command: &str, version_arg: &str) -> Option<String> {
    Command::new(command)
        .arg(version_arg)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                String::from_utf8(output.stdout)
                    .ok()
                    .or_else(|| String::from_utf8(output.stderr).ok())
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
}

/// 检测 Node.js/npm/npx 环境
pub fn check_node_environment() -> PackageManagerInfo {
    let npx_available = is_command_available("npx");
    let npm_available = is_command_available("npm");
    let node_available = is_command_available("node");

    let version = if npx_available {
        get_command_version("npx", "--version")
    } else if npm_available {
        get_command_version("npm", "--version")
    } else if node_available {
        get_command_version("node", "--version")
    } else {
        None
    };

    let mut install_hints = Vec::new();

    if !node_available && !npm_available {
        install_hints.push("Node.js 未安装".to_string());

        if cfg!(target_os = "macos") {
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • Homebrew: brew install node".to_string());
            install_hints.push("  • 官方下载: https://nodejs.org".to_string());
            install_hints.push("  • nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && nvm install node".to_string());
        } else if cfg!(target_os = "windows") {
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • Chocolatey: choco install nodejs".to_string());
            install_hints.push("  • Scoop: scoop install nodejs".to_string());
            install_hints.push("  • 官方下载: https://nodejs.org".to_string());
            install_hints.push("  • Winget: winget install OpenJS.NodeJS".to_string());
        } else {
            install_hints.push("推荐安装方式：".to_string());
            install_hints
                .push("  • 包管理器: sudo apt install nodejs npm (Debian/Ubuntu)".to_string());
            install_hints.push("  • 包管理器: sudo yum install nodejs (RedHat/CentOS)".to_string());
            install_hints.push("  • 官方下载: https://nodejs.org".to_string());
        }
    }

    PackageManagerInfo {
        manager_type: "npm/npx".to_string(),
        is_available: npx_available || npm_available,
        version,
        install_command: None, // npm 需要手动安装，不提供自动安装
        install_hints,
    }
}

/// 检测 Python/pip 环境
pub fn check_python_environment() -> PackageManagerInfo {
    let pip_available = is_command_available("pip") || is_command_available("pip3");
    let python_available = is_command_available("python") || is_command_available("python3");

    let version = if pip_available {
        get_command_version("pip", "--version").or_else(|| get_command_version("pip3", "--version"))
    } else if python_available {
        get_command_version("python", "--version")
            .or_else(|| get_command_version("python3", "--version"))
    } else {
        None
    };

    let mut install_hints = Vec::new();

    if !python_available {
        install_hints.push("Python 未安装".to_string());

        if cfg!(target_os = "macos") {
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • Homebrew: brew install python".to_string());
            install_hints.push("  • 官方下载: https://www.python.org/downloads/".to_string());
        } else if cfg!(target_os = "windows") {
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • Chocolatey: choco install python".to_string());
            install_hints.push("  • Scoop: scoop install python".to_string());
            install_hints.push("  • 官方下载: https://www.python.org/downloads/".to_string());
            install_hints.push("  • Winget: winget install Python.Python.3.12".to_string());
        } else {
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • 包管理器: sudo apt install python3 python3-pip".to_string());
            install_hints.push("  • 官方下载: https://www.python.org/downloads/".to_string());
        }
    }

    PackageManagerInfo {
        manager_type: "pip/python".to_string(),
        is_available: pip_available || python_available,
        version,
        install_command: None,
        install_hints,
    }
}

/// 检测 uv (Python 包管理器) 环境
pub fn check_uv_environment() -> PackageManagerInfo {
    let uv_available = is_command_available("uv");
    let version = if uv_available {
        get_command_version("uv", "--version")
    } else {
        None
    };

    let mut install_hints = Vec::new();
    let install_command;

    if !uv_available {
        install_hints.push("uv 未安装（高性能 Python 包管理器）".to_string());

        if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
            install_command = Some("curl -LsSf https://astral.sh/uv/install.sh | sh".to_string());
            install_hints.push("推荐安装方式：".to_string());
            install_hints
                .push("  • 一键安装: curl -LsSf https://astral.sh/uv/install.sh | sh".to_string());
            install_hints.push("  • Homebrew: brew install uv".to_string());
        } else if cfg!(target_os = "windows") {
            install_command = Some("powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"".to_string());
            install_hints.push("推荐安装方式：".to_string());
            install_hints
                .push("  • PowerShell: irm https://astral.sh/uv/install.ps1 | iex".to_string());
            install_hints.push("  • Scoop: scoop install uv".to_string());
        } else {
            install_command = None;
        }
    } else {
        install_command = None;
    }

    PackageManagerInfo {
        manager_type: "uv".to_string(),
        is_available: uv_available,
        version,
        install_command,
        install_hints,
    }
}

/// 检测 Cargo (Rust 包管理器) 环境
pub fn check_cargo_environment() -> PackageManagerInfo {
    let cargo_available = is_command_available("cargo");
    let version = if cargo_available {
        get_command_version("cargo", "--version")
    } else {
        None
    };

    let mut install_hints = Vec::new();
    let install_command;

    if !cargo_available {
        install_hints.push("Cargo/Rust 未安装".to_string());

        if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
            install_command =
                Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh".to_string());
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push(
                "  • Rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
                    .to_string(),
            );
            install_hints.push("  • Homebrew: brew install rust".to_string());
        } else if cfg!(target_os = "windows") {
            install_command = None;
            install_hints.push("推荐安装方式：".to_string());
            install_hints.push("  • 下载 rustup-init.exe: https://rustup.rs".to_string());
            install_hints.push("  • Scoop: scoop install rustup".to_string());
        } else {
            install_command = None;
        }
    } else {
        install_command = None;
    }

    PackageManagerInfo {
        manager_type: "cargo".to_string(),
        is_available: cargo_available,
        version,
        install_command,
        install_hints,
    }
}

/// 根据命令自动检测所需的包管理器
pub fn detect_required_package_manager(command: &str) -> Option<PackageManagerInfo> {
    let cmd_lower = command.to_lowercase();

    if cmd_lower == "npx" || cmd_lower.ends_with("npx.cmd") || cmd_lower.ends_with("npx.exe") {
        Some(check_node_environment())
    } else if cmd_lower == "uv" || cmd_lower.ends_with("uv.exe") {
        Some(check_uv_environment())
    } else if cmd_lower == "pip"
        || cmd_lower == "pip3"
        || cmd_lower == "python"
        || cmd_lower == "python3"
    {
        Some(check_python_environment())
    } else if cmd_lower == "cargo" {
        Some(check_cargo_environment())
    } else {
        None
    }
}

/// N12：异步执行安装命令——tokio::process + 总 deadline + kill_on_drop +
/// 有界输出捕获（持续排空管道、只保留前 1 MiB）。此前在 async fn 里直接
/// `std::process::Command::output()`：安装脚本挂起会长期占住 runtime
/// 工作线程，且无超时、无取消、无输出预算。
async fn run_install_command(install_cmd: &str) -> Result<(bool, String), String> {
    run_install_command_with_timeout(install_cmd, INSTALL_TIMEOUT).await
}

async fn run_install_command_with_timeout(
    install_cmd: &str,
    timeout: Duration,
) -> Result<(bool, String), String> {
    use tokio::io::AsyncReadExt;

    /// 持续排空一个输出流，只保留前 `cap` 字节（超出部分读了就丢，
    /// 防止子进程因管道满而卡住）。
    async fn drain_capped<R: tokio::io::AsyncRead + Unpin>(mut reader: R, cap: usize) -> Vec<u8> {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(kept.len());
                    if room > 0 {
                        kept.extend_from_slice(&buf[..n.min(room)]);
                    }
                }
            }
        }
        kept
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.arg("-Command")
            .arg(install_cmd)
            .creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(install_cmd);
        c
    };

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动安装进程失败: {}", e))?;

    let stdout_task = child
        .stdout
        .take()
        .map(|s| tokio::spawn(drain_capped(s, MAX_INSTALL_OUTPUT_BYTES)));
    let stderr_task = child
        .stderr
        .take()
        .map(|s| tokio::spawn(drain_capped(s, MAX_INSTALL_OUTPUT_BYTES)));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => return Err(format!("等待安装进程失败: {}", e)),
        Err(_) => {
            // 总 deadline：终止并回收子进程，避免残留孤儿安装进程
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!(
                "安装超时（{} 秒），已终止安装进程",
                timeout.as_secs()
            ));
        }
    };

    let stderr_bytes = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    };
    if let Some(task) = stdout_task {
        let _ = task.await;
    }

    Ok((
        status.success(),
        String::from_utf8_lossy(&stderr_bytes).to_string(),
    ))
}

/// 尝试自动安装包管理器（仅支持有安全安装命令的）
pub async fn auto_install_package_manager(manager_type: &str) -> PackageInstallResult {
    // N12：同步子进程探测放进 blocking 池，不占 runtime 工作线程
    let manager = manager_type.to_string();
    let probed = tokio::task::spawn_blocking(move || match manager.as_str() {
        "uv" => Some(check_uv_environment()),
        "cargo" if cfg!(not(target_os = "windows")) => Some(check_cargo_environment()),
        _ => None,
    })
    .await;
    let info = match probed {
        Ok(Some(info)) => info,
        Ok(None) => {
            return PackageInstallResult {
                success: false,
                message: format!("不支持自动安装 {}，请手动安装", manager_type),
                installed_version: None,
            };
        }
        Err(e) => {
            return PackageInstallResult {
                success: false,
                message: format!("环境检测失败: {}", e),
                installed_version: None,
            };
        }
    };

    if info.is_available {
        return PackageInstallResult {
            success: true,
            message: format!("{} 已安装", manager_type),
            installed_version: info.version.clone(),
        };
    }

    let install_cmd = match &info.install_command {
        Some(cmd) => cmd.clone(),
        None => {
            return PackageInstallResult {
                success: false,
                message: format!(
                    "{} 需要手动安装。安装提示：\n{}",
                    manager_type,
                    info.install_hints.join("\n")
                ),
                installed_version: None,
            };
        }
    };

    // 执行安装命令（N12：异步、有 deadline、有输出预算）
    log::info!("正在自动安装 {}: {}", manager_type, install_cmd);

    match run_install_command(&install_cmd).await {
        Ok((true, _stderr)) => {
            // 重新检测版本（同步探测放进 blocking 池，不占 runtime 工作线程）
            let manager = manager_type.to_string();
            let info_fallback = info.clone();
            let new_info = tokio::task::spawn_blocking(move || match manager.as_str() {
                "uv" => check_uv_environment(),
                "cargo" => check_cargo_environment(),
                _ => info_fallback,
            })
            .await
            .unwrap_or_else(|_| info.clone());

            PackageInstallResult {
                success: true,
                message: format!("{} 安装成功", manager_type),
                installed_version: new_info.version,
            }
        }
        Ok((false, stderr)) => PackageInstallResult {
            success: false,
            message: format!("{} 安装失败: {}", manager_type, stderr),
            installed_version: None,
        },
        Err(e) => PackageInstallResult {
            success: false,
            message: format!("{} 安装失败: {}", manager_type, e),
            installed_version: None,
        },
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_command_success_captures_status() {
        let (success, _stderr) = run_install_command_with_timeout(
            "echo hello",
            Duration::from_secs(10),
        )
        .await
        .expect("spawn ok");
        assert!(success);
    }

    #[tokio::test]
    async fn install_command_failure_captures_stderr() {
        let (success, stderr) = run_install_command_with_timeout(
            "echo boom >&2; exit 3",
            Duration::from_secs(10),
        )
        .await
        .expect("spawn ok");
        assert!(!success);
        assert!(stderr.contains("boom"), "stderr 应被捕获: {}", stderr);
    }

    #[tokio::test]
    async fn install_command_timeout_kills_child() {
        let start = std::time::Instant::now();
        let result = run_install_command_with_timeout(
            "sleep 60",
            Duration::from_millis(100),
        )
        .await;
        let elapsed = start.elapsed();
        assert!(result.is_err(), "超时必须报错");
        assert!(result.unwrap_err().contains("超时"));
        assert!(
            elapsed < Duration::from_secs(10),
            "超时后必须立即返回（kill + reap），实际 {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn install_command_large_output_is_capped_and_drained() {
        // 输出远超 1 MiB 上限：必须正常结束（管道持续排空）且不 OOM
        let (success, _) = run_install_command_with_timeout(
            "yes | head -c 5000000",
            Duration::from_secs(30),
        )
        .await
        .expect("spawn ok");
        assert!(success);
    }
}
