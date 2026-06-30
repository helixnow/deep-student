//! 电源管理命令：防休眠（制卡等长任务期间保持系统唤醒）
//!
//! - macOS: 通过系统自带 `caffeinate -i -w <pid>` 子进程阻止 idle sleep
//! - Linux: 优先 `systemd-inhibit`，子进程存活期间阻止 sleep
//! - Windows: 暂未实现（需要常驻线程调用 SetThreadExecutionState），返回 false
//!
//! 设计为幂等：重复开启不会叠加子进程。
//!
//! ★ 2026-06-12（审阅问题）：子进程必须把生命周期绑定到本进程，否则应用
//! 崩溃/被 kill（未走 disable 路径）时 caffeinate / systemd-inhibit 会变成
//! 孤儿进程，系统将永久无法休眠：
//! - macOS 用 `-w <pid>`：被观察进程退出后 caffeinate 自动结束断言；
//! - Linux 用 `systemd-inhibit ... tail --pid=<pid> -f /dev/null`：父进程
//!   退出后 tail 立即退出，抑制随之解除（tail 为 coreutils 必备组件）。

use std::sync::Mutex;
use tracing::{info, warn};

#[cfg(any(target_os = "macos", target_os = "linux"))]
static SLEEP_GUARD: Mutex<Option<std::process::Child>> = Mutex::new(None);

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
static SLEEP_GUARD: Mutex<Option<()>> = Mutex::new(None);

/// 开启/关闭防休眠。返回当前是否处于防休眠状态。
#[tauri::command]
pub fn set_prevent_sleep(enabled: bool) -> Result<bool, String> {
    let mut guard = SLEEP_GUARD
        .lock()
        .map_err(|e| format!("sleep guard lock poisoned: {e}"))?;

    if enabled {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            // 已开启且子进程仍存活则保持现状
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(None) => return Ok(true),
                    _ => *guard = None, // 已退出，重新拉起
                }
            }

            let spawned = spawn_inhibitor();
            match spawned {
                Ok(child) => {
                    info!("[power] prevent-sleep enabled (pid={})", child.id());
                    *guard = Some(child);
                    Ok(true)
                }
                Err(e) => {
                    warn!("[power] failed to enable prevent-sleep: {e}");
                    Err(e)
                }
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            warn!("[power] prevent-sleep not supported on this platform");
            Ok(false)
        }
    } else {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            info!("[power] prevent-sleep disabled");
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            *guard = None;
        }
        Ok(false)
    }
}

/// 查询当前防休眠状态
#[tauri::command]
pub fn get_prevent_sleep() -> Result<bool, String> {
    let mut guard = SLEEP_GUARD
        .lock()
        .map_err(|e| format!("sleep guard lock poisoned: {e}"))?;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(true),
                _ => *guard = None,
            }
        }
        Ok(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = &mut guard;
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn spawn_inhibitor() -> Result<std::process::Child, String> {
    // -i 阻止 idle sleep；不阻止显示器睡眠（任务在后台跑，无需亮屏）。
    // -w <pid>：本进程退出（含崩溃）后 caffeinate 自动结束，防止孤儿进程
    // 永久阻止系统休眠。
    std::process::Command::new("caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .spawn()
        .map_err(|e| format!("failed to spawn caffeinate: {e}"))
}

#[cfg(target_os = "linux")]
fn spawn_inhibitor() -> Result<std::process::Child, String> {
    // systemd-inhibit 包裹 `tail --pid=<本进程> -f /dev/null`：
    // 正常关闭走 disable 路径 kill；异常退出时 tail 检测到父进程消失而自行
    // 退出，抑制随之解除，避免 `sleep infinity` 孤儿进程永久阻止休眠。
    std::process::Command::new("systemd-inhibit")
        .args([
            "--what=sleep:idle",
            "--who=DeepStudent",
            "--why=Long-running card generation task",
            "tail",
            &format!("--pid={}", std::process::id()),
            "-f",
            "/dev/null",
        ])
        .spawn()
        .map_err(|e| format!("failed to spawn systemd-inhibit: {e}"))
}
