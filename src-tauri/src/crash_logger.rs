use chrono::Utc;
use sentry::protocol::Event;
use std::backtrace::Backtrace;
use std::borrow::Cow;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::sync::OnceLock;

static CRASH_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static CRASH_HOOK_INIT: Once = Once::new();

const MAX_CRASH_LOGS: usize = 20;

/// 初始化崩溃日志记录器，并注册 panic hook。
pub fn init_crash_logging(app_data_dir: PathBuf) {
    let crash_dir = app_data_dir.join("logs").join("crash");

    if let Err(err) = fs::create_dir_all(&crash_dir) {
        eprintln!("[CrashLogger] 创建崩溃日志目录失败: {}", err);
    }

    cleanup_old_crash_logs(&crash_dir);

    let _ = CRASH_LOG_DIR.set(crash_dir.clone());

    CRASH_HOOK_INIT.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            // 写本地日志，包在 catch_unwind 中防止 double panic
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Some(dir) = CRASH_LOG_DIR.get() {
                    if let Err(err) = write_crash_log(dir, panic_info) {
                        eprintln!("[CrashLogger] 写入崩溃日志失败: {}", err);
                    }
                }
            }));

            // Sentry 上报，单独 catch
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let payload = format!("{}", panic_info);
                let fingerprint = if let Some(loc) = panic_info.location() {
                    vec![
                        Cow::Borrowed("rust-panic"),
                        Cow::Owned(format!("{}:{}", loc.file(), loc.line())),
                    ]
                } else {
                    vec![Cow::Borrowed("rust-panic"), Cow::Borrowed("unknown")]
                };

                sentry::capture_event(Event {
                    message: Some(scrub_pii(&payload)),
                    level: sentry::Level::Fatal,
                    release: Some(Cow::Owned(format!(
                        "{}+{}",
                        env!("CARGO_PKG_VERSION"),
                        env!("BUILD_NUMBER"),
                    ))),
                    fingerprint: Cow::Owned(fingerprint),
                    extra: {
                        let mut map = std::collections::BTreeMap::new();
                        map.insert("git_hash".into(), env!("GIT_HASH").into());
                        map.insert("build_number".into(), env!("BUILD_NUMBER").into());
                        map
                    },
                    ..Default::default()
                });

                sentry::Hub::current().client().map(|c| c.flush(Some(std::time::Duration::from_secs(2))));
            }));

            previous_hook(panic_info);
        }));
    });
}

/// 清理旧崩溃日志，只保留最新的 MAX_CRASH_LOGS 个文件。
fn cleanup_old_crash_logs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut logs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("crash-")
        })
        .collect();

    if logs.len() <= MAX_CRASH_LOGS {
        return;
    }

    logs.sort_by_key(|e| {
        e.metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });

    let to_remove = logs.len() - MAX_CRASH_LOGS;
    for entry in logs.into_iter().take(to_remove) {
        let _ = fs::remove_file(entry.path());
    }
}

/// 脱敏：移除文件路径中的用户名部分
fn scrub_pii(input: &str) -> String {
    let result = input.to_string();
    #[cfg(target_os = "windows")]
    {
        let re = regex::Regex::new(r"(?i)[A-Z]:\\Users\\[^\\]+\\").ok();
        if let Some(re) = re {
            return re.replace_all(&result, "C:\\Users\\<REDACTED>\\").to_string();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let re = regex::Regex::new(r"/(?:home|Users)/[^/]+/").ok();
        if let Some(re) = re {
            return re.replace_all(&result, "/<REDACTED>/").to_string();
        }
    }
    result
}

fn write_crash_log(
    destination: &Path,
    panic_info: &std::panic::PanicHookInfo<'_>,
) -> io::Result<()> {
    let now = Utc::now();
    let file_name = format!(
        "crash-{}-pid{}.log",
        now.format("%Y-%m-%dT%H-%M-%S%.3fZ"),
        std::process::id()
    );
    let path = destination.join(file_name);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut buffer = String::new();
    buffer.push_str("=== Deep Student 崩溃日志 ===\n");
    buffer.push_str(&format!("时间: {}\n", now.to_rfc3339()));
    buffer.push_str(&format!(
        "版本: {} (Build {}, {})\n",
        env!("CARGO_PKG_VERSION"),
        env!("BUILD_NUMBER"),
        env!("GIT_HASH"),
    ));
    buffer.push_str(&format!("进程: {}\n", std::process::id()));
    buffer.push_str(&format!(
        "线程: {}\n",
        std::thread::current().name().unwrap_or("unnamed")
    ));

    let location = panic_info
        .location()
        .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
        .unwrap_or_else(|| "未知位置".to_string());
    buffer.push_str(&format!("位置: {}\n", location));

    buffer.push_str("错误: ");
    if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
        buffer.push_str(s);
    } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
        buffer.push_str(s);
    } else {
        buffer.push_str("无法解析的 panic payload");
    }
    buffer.push('\n');

    buffer.push_str("回溯:\n");
    let backtrace = Backtrace::force_capture();
    buffer.push_str(&format!("{:?}\n", backtrace));

    fs::write(path, buffer)
}
