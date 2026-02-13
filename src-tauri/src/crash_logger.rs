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

/// 初始化崩溃日志记录器，并注册 panic hook。
pub fn init_crash_logging(app_data_dir: PathBuf) {
    let crash_dir = app_data_dir.join("logs").join("crash");

    if let Err(err) = fs::create_dir_all(&crash_dir) {
        eprintln!("⚠️ [CrashLogger] 创建崩溃日志目录失败: {}", err);
    }

    let _ = CRASH_LOG_DIR.set(crash_dir.clone());

    CRASH_HOOK_INIT.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            if let Some(dir) = CRASH_LOG_DIR.get() {
                if let Err(err) = write_crash_log(dir, panic_info) {
                    eprintln!("⚠️ [CrashLogger] 写入崩溃日志失败: {}", err);
                }
            } else {
                eprintln!("⚠️ [CrashLogger] 未初始化崩溃日志目录");
            }

            // 发送到 Sentry（若已初始化）
            let payload = format!("{:?}", panic_info);
            sentry::capture_event(Event {
                message: Some("Rust panic".into()),
                level: sentry::Level::Fatal,
                release: Some(Cow::Owned(format!(
                    "{}+{}",
                    env!("CARGO_PKG_VERSION"),
                    env!("BUILD_NUMBER"),
                ))),
                fingerprint: Cow::Owned(vec![Cow::Borrowed("rust-panic")]),
                extra: {
                    let mut map = std::collections::BTreeMap::new();
                    map.insert("panic_info".into(), payload.into());
                    map.insert("git_hash".into(), env!("GIT_HASH").into());
                    map.insert("build_number".into(), env!("BUILD_NUMBER").into());
                    map
                },
                ..Default::default()
            });

            previous_hook(panic_info);
        }));
    });
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
