//! 电源管理命令：防休眠（制卡等长任务期间保持系统唤醒）
//!
//! - macOS: 通过系统自带 `caffeinate -i` 子进程阻止 idle sleep
//! - Linux: 优先 `systemd-inhibit`，子进程存活期间阻止 sleep
//! - Windows: 暂未实现（需要常驻线程调用 SetThreadExecutionState），返回 false
//!
//! 设计为幂等：重复开启不会叠加子进程；应用退出时子进程随父进程回收
//! （caffeinate 在父进程退出后自动结束断言）。

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
    // -i 阻止 idle sleep；不阻止显示器睡眠（任务在后台跑，无需亮屏）
    std::process::Command::new("caffeinate")
        .arg("-i")
        .spawn()
        .map_err(|e| format!("failed to spawn caffeinate: {e}"))
}

#[cfg(target_os = "linux")]
fn spawn_inhibitor() -> Result<std::process::Child, String> {
    // systemd-inhibit 包裹一个长 sleep；子进程被 kill 时抑制解除
    std::process::Command::new("systemd-inhibit")
        .args([
            "--what=sleep:idle",
            "--who=DeepStudent",
            "--why=Long-running card generation task",
            "sleep",
            "infinity",
        ])
        .spawn()
        .map_err(|e| format!("failed to spawn systemd-inhibit: {e}"))
}
