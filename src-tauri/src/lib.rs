// Deep Student library entry
// 提供 run() 供 bin 目标调用，以解决编译错误。
// 后续可在此处逐步引入 invoke_handler! 和实际命令函数列表。

// 声明所有子模块，以便在 crate 内可见
pub mod adapters;
pub mod anki;
pub mod anki_connect_service;
#[allow(dead_code)]
pub mod apkg_exporter_service;
pub mod apkg_importer_service;
#[allow(dead_code)]
pub mod backup_job_manager;
pub mod batch_operations;
pub mod canonical_tools;
pub mod cmd;
#[allow(dead_code)]
pub mod commands;
pub mod config_recovery;
pub mod crash_logger;
#[allow(dead_code)]
pub mod crypto;
#[allow(dead_code)]
pub mod database;
pub mod debug_commands;
pub mod debug_log_service; // 调试日志持久化服务（JSON 文件 + 多级过滤）
pub mod debug_logger;

pub mod anr_watchdog; // 异步运行时看门狗（检测 tokio runtime 饥饿，非 UI 主线程 ANR，见模块文档）
pub mod background_tasks; // 全局后台任务追踪器（Audit 2 R-2.6：统一管理 fire-and-forget 任务并支持优雅关闭）
pub mod backup_common;
pub mod backup_config;
pub mod browser; // Workbench 内置浏览器（browser.db 懒加载 + 导航策略；见 design §9）
#[allow(dead_code)]
pub mod chat_v2; // Chat V2 - 新版聊天后端模块（基于 Block 架构）
#[allow(dead_code)]
pub mod cloud_storage;
pub mod cross_page_merger;
pub mod data_space;
pub mod deepseek_ocr_parser;
pub mod diagnostics;
#[allow(dead_code)]
pub mod document_parser;
pub mod document_processing_service;
pub mod dstu;
pub mod enhanced_anki_service;
pub mod error_details;
pub mod error_recovery;
pub mod essay_grading;
#[allow(dead_code)]
pub mod exam_sheet_service;
pub mod feature_flags;
pub mod figure_extractor;
pub mod file_manager;
pub mod file_stream_protocol; // filestream:// 通用媒体/blob 流式加载协议（复用 pdfstream 安全模式）
pub mod fsrs_review_service; // FSRS 闪卡复习服务（独立于题库 review_plans）
pub mod injection_budget;
pub mod json_validator;
#[allow(dead_code)]
pub mod lance_vector_store;
#[allow(dead_code)]
pub mod llm_manager;
pub mod llm_structurer;
pub mod llm_usage; // LLM 使用量统计模块（独立 llm_usage.db）
pub mod mastery; // 掌握度中间层（A-P0 回流画像 + A-P1 FSRS 调度偏置）
#[cfg(feature = "mcp")]
pub mod mcp;
#[allow(dead_code)]
pub mod memory; // Memory-as-VFS 记忆系统（复用 VFS 基础设施）
pub mod metrics_server;
pub mod models;
#[allow(dead_code, deprecated)]
pub mod multimodal; // 多模态知识库模块（基于 Qwen3-VL-Embedding/Reranker）
#[allow(dead_code)]
pub mod notes_exporter;
pub mod notes_manager;
pub mod ocr_adapters; // OCR 适配器模块（支持多种 OCR 引擎）
pub mod ocr_circuit_breaker; // OCR 熔断器（三态：Closed/Open/HalfOpen）
pub mod openai_codex;
pub mod package_manager;
pub mod page_rasterizer;
pub mod pdf_ocr_service;
pub mod pdf_protocol;
pub mod pdfium_utils; // Pdfium 公共工具（库加载 + 文本提取）
pub mod providers;
pub mod qbank_grading;
#[allow(dead_code)]
pub mod question_bank_service;
pub mod question_export_service;
#[allow(dead_code)]
pub mod question_import_service;
pub mod question_sync_service;
pub mod quick_assistant; // 快速学习小窗的原生窗口生命周期管理
pub mod reasoning_policy; // 思维链回传策略模块（文档 29 第 7 节）
pub mod review_plan_service; // 复习计划服务（与错题系统集成）
pub mod secret_prompt;
pub mod secure_store;
pub mod services;
pub mod spaced_repetition;
pub mod startup_cleanup;
#[allow(dead_code)]
pub mod streaming_anki_service;
pub mod system_notification;
pub mod system_permissions;
#[allow(dead_code)]
pub mod test_utils;
pub mod textbooks_db;
#[allow(dead_code)]
pub mod tools;
pub mod translation;
pub mod tts; // 可选的系统 TTS（Web Speech API 回退方案）
#[allow(dead_code)]
pub mod unified_file_manager;
#[allow(dead_code)]
pub mod utils;
pub mod vector_store;
pub mod vendors;
#[allow(dead_code, deprecated)]
pub mod vfs; // VFS 虚拟文件系统（统一资源存储） // DSTU 访达协议层（VFS 的文件系统语义接口）
pub mod vlm_grounding_service;
pub mod voice_input;
pub mod workflow_error_handler; // SM-2 间隔重复算法 // 题目集同步冲突策略服务

// 数据治理模块（条件编译，需启用 data_governance feature）
#[cfg(feature = "data_governance")]
#[allow(dead_code)]
pub mod data_governance;

// macOS 原生菜单栏（Phase D2 of native-feel migration, 2026-05-14）
#[cfg(target_os = "macos")]
pub mod menu;

// Add required imports for AppState initialization
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
// Tokio is already in dependencies and used across the codebase
use tokio::sync::{Mutex, RwLock};
// Register Tauri plugins for dialog, opener and http
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
// Sentry for Rust (后端)
use sentry::ClientInitGuard;
use tracing::{debug, error, info, warn};

// 全局 AppHandle，用于在任意位置发送 Tauri 事件
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_global_app_handle(app_handle: AppHandle) {
    let _ = GLOBAL_APP_HANDLE.set(app_handle);
}

pub fn get_global_app_handle() -> Option<&'static AppHandle> {
    GLOBAL_APP_HANDLE.get()
}

pub struct BackendSentryState(std::sync::Arc<std::sync::Mutex<Option<ClientInitGuard>>>);

fn init_backend_sentry_client() -> Option<ClientInitGuard> {
    let configured_dsn = std::env::var("SENTRY_DSN")
        .ok()
        .or_else(|| option_env!("SENTRY_DSN").map(str::to_string));
    let raw_dsn = match configured_dsn {
        Some(value) if !value.trim().is_empty() => value,
        _ => {
            warn!("[Sentry] user consent is enabled, but backend DSN is not configured");
            return None;
        }
    };
    let dsn = match raw_dsn.parse::<sentry::types::Dsn>() {
        Ok(value) => value,
        Err(_) => {
            warn!("[Sentry] backend DSN is invalid; error reporting remains disabled");
            return None;
        }
    };
    let guard = sentry::init(sentry::ClientOptions {
        dsn: Some(dsn),
        release: Some(env!("SENTRY_RELEASE").into()),
        send_default_pii: false,
        // Panic/ANR are captured explicitly through Hub::main so consent can be
        // changed at runtime without stale thread-local integrations.
        default_integrations: false,
        ..Default::default()
    });
    sentry::Hub::main().bind_client(sentry::Hub::current().client());
    info!("[Sentry] backend error reporting enabled by user consent");
    Some(guard)
}

mod backend_sentry_command {
    use super::{init_backend_sentry_client, BackendSentryState};
    use log::info;

    #[tauri::command]
    pub async fn set_backend_sentry_enabled(
        enabled: bool,
        state: tauri::State<'_, BackendSentryState>,
        app_state: tauri::State<'_, crate::commands::AppState>,
    ) -> Result<bool, String> {
        let sentry_state = state.0.clone();
        let database = app_state.database.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = sentry_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            database
                .save_setting("sentry_error_reporting_enabled", &enabled.to_string())
                .map_err(|e| format!("保存错误报告授权失败: {}", e))?;
            if enabled {
                if guard.is_none() {
                    *guard = init_backend_sentry_client();
                }
                Ok(guard.is_some())
            } else {
                let previous = guard.take();
                sentry::Hub::main().bind_client(None);
                sentry::Hub::current().bind_client(None);
                drop(guard);
                drop(previous);
                info!("[Sentry] backend error reporting disabled");
                Ok(false)
            }
        })
        .await
        .map_err(|e| format!("更新错误报告授权任务失败: {}", e))?
    }
}
// tracing 日志初始化由 tauri-plugin-log 统一管理

#[cfg(target_os = "linux")]
fn prepare_linux_appimage_runtime_env() {
    let is_appimage =
        std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
    if !is_appimage {
        return;
    }

    // AppImage runtime may inject GTK-related paths that mismatch host GTK modules.
    // Clear the high-risk variables to reduce init crashes like "Failed to initialize GTK".
    for key in [
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GTK_IM_MODULE_FILE",
    ] {
        if std::env::var_os(key).is_some() {
            std::env::remove_var(key);
        }
    }

    // Keep backend choice flexible but prioritize Wayland when present.
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "wayland,x11");
    }

    // Reduce known WebKit/GPU instability on some Linux desktop stacks.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// 启动 Tauri 应用。
///
/// 目前仅做最小实现，后续可补充 `invoke_handler!` 以注册命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(deprecated)]
pub fn run() {
    // 环境变量在 run() 最前面设置（审阅 34 P2-3 / 19 P2-2）：
    // 此时 Sentry/tokio/ANR 看门狗等工作线程尚未启动，set_var 不存在
    // 多线程 getenv 数据竞争；原先放在 setup 闭包里时该前提不成立。
    // Windows WebView2 参数由 tauri.windows.conf.json 的 additionalBrowserArgs 注入。
    // ANTI-REGRESSION（2026-07-10）：禁止在此处或 tauri.windows.conf.json 的
    // additionalBrowserArgs 里加 --disable-gpu / --disable-gpu-compositing /
    // CalculateNativeWinOcclusion。OS 模式 translate3d 拖窗依赖 GPU 合成；
    // 全局软件渲染会造成固定起拖卡顿。仅保留 OOUI/SmartScreen 相关 disable-features；
    // 显卡级问题用设备白名单回退，勿全局禁用。macOS/Linux 无此开关，勿在平台 conf 仿写。

    // 始终开启 Rust backtrace，便于 crash 日志定位
    std::env::set_var("RUST_BACKTRACE", "1");

    // 默认压降第三方过度详细的日志（可用 RUST_LOG 覆盖）
    if std::env::var("RUST_LOG").is_err() {
        // info 级别，且降低 lance/lancedb 噪声
        std::env::set_var("RUST_LOG", "info,lance=warn,lancedb=warn,tracing=warn");
    }

    #[cfg(target_os = "linux")]
    prepare_linux_appimage_runtime_env();

    // 统一使用 tauri-plugin-log 初始化日志系统，避免与 tracing_subscriber/全局 logger 冲突

    // 构建 Tauri 应用
    let builder = tauri::Builder::default().on_page_load(|webview, payload| {
        // 在前端 bundle 执行前安装极小的错误桥，覆盖入口脚本加载失败/白屏。
        // main.tsx 成功启动后会注销这些监听，再由统一 errorReporter 接管。
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            let _ = webview.eval(
                r#"
                (() => {
                  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__?.();
                  let active = true;
                  const report = (kind, message, stack, extra) => {
                    const invoke = window.__TAURI_INTERNALS__?.invoke;
                    if (!active || typeof invoke !== 'function') return;
                    void invoke('report_frontend_log', {
                      payload: {
                        level: 'ERROR',
                        kind,
                        message: String(message || kind),
                        stack: stack || null,
                        route: location.hash || location.pathname,
                        url: location.href,
                        user_agent: navigator.userAgent,
                        extra: extra || null,
                      },
                    }).catch(() => {});
                  };
                  const onError = event => {
                    const target = event.target;
                    const resource = target && target !== window
                      ? (target.src || target.href || target.tagName)
                      : null;
                    report(
                      resource ? 'BOOT_RESOURCE_ERROR' : 'BOOT_WINDOW_ERROR',
                      event.message || ('Failed to load resource: ' + (resource || 'unknown')),
                      event.error?.stack,
                      resource ? { resource } : null,
                    );
                  };
                  const onRejection = event => {
                    const reason = event.reason;
                    report(
                      'BOOT_UNHANDLED_REJECTION',
                      reason instanceof Error ? reason.message : String(reason),
                      reason instanceof Error ? reason.stack : null,
                    );
                  };
                  const onCsp = event => {
                    report(
                      'BOOT_CSP_VIOLATION',
                      'CSP blocked ' + event.blockedURI + ' via ' + event.violatedDirective,
                    );
                  };
                  window.addEventListener('error', onError, true);
                  window.addEventListener('unhandledrejection', onRejection, true);
                  window.addEventListener('securitypolicyviolation', onCsp, true);
                  const blankTimer = setTimeout(() => {
                    const root = document.getElementById('root');
                    if (!root || root.childElementCount === 0) {
                      report('BOOT_BLANK_SCREEN', 'Application root is empty after startup timeout');
                    }
                  }, 8000);
                  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__ = () => {
                    active = false;
                    clearTimeout(blankTimer);
                    window.removeEventListener('error', onError, true);
                    window.removeEventListener('unhandledrejection', onRejection, true);
                    window.removeEventListener('securitypolicyviolation', onCsp, true);
                    delete window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__;
                  };
                })();
                "#,
            );
        }

        if std::env::var_os("TAURI_LAB_INSTANCE_ID").is_none() {
            return;
        }

        info!(
            "[tauri-lab] page load event: {:?} {}",
            payload.event(),
            payload.url()
        );

        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            let _ = webview.eval(
                r#"
                (() => {
                  if (window.__TAURI_LAB_BOOT_DIAGNOSTICS__) return;
                  window.__TAURI_LAB_BOOT_DIAGNOSTICS__ = true;
                  const report = (level, message, stack) => {
                    const invoke = window.__TAURI_INTERNALS__?.invoke;
                    if (typeof invoke !== 'function') return;
                    void invoke('tauri_lab_frontend_log', {
                      level,
                      message: '[bootstrap] ' + message,
                      stack: stack || null,
                    }).catch(() => {});
                  };
                  const serialize = value => {
                    if (value instanceof Error) {
                      return value.name + ': ' + value.message;
                    }
                    if (typeof value === 'string') return value;
                    try {
                      return JSON.stringify(value);
                    } catch (_) {
                      return String(value);
                    }
                  };
                  for (const level of ['warn', 'error']) {
                    const original = console[level]?.bind(console);
                    console[level] = (...args) => {
                      try { original?.(...args); } catch (_) {}
                      const error = args.find(value => value instanceof Error);
                      report(
                        level,
                        'console.' + level + ': ' + args.map(serialize).join(' '),
                        error instanceof Error ? error.stack : null,
                      );
                    };
                  }
                  window.addEventListener('error', event => {
                    const target = event.target;
                    const resource = target?.src || target?.href || target?.tagName;
                    report(
                      'error',
                      event.message || ('resource error: ' + (resource || 'unknown')),
                      event.error?.stack,
                    );
                  }, true);
                  window.addEventListener('unhandledrejection', event => {
                    const reason = event.reason;
                    report(
                      'error',
                      reason instanceof Error ? reason.message : String(reason),
                      reason instanceof Error ? reason.stack : null,
                    );
                  }, true);
                  window.addEventListener('securitypolicyviolation', event => {
                    report(
                      'error',
                      'CSP blocked ' + event.blockedURI + ' via ' + event.violatedDirective,
                    );
                  }, true);
                  report('info', 'page started: ' + location.href);
                  const observeRoot = () => {
                    const root = document.getElementById('root');
                    if (!root) return;
                    new MutationObserver(() => {
                      report(
                        'info',
                        'root mutation children=' + root.childElementCount
                          + ' html=' + root.innerHTML.slice(0, 240),
                      );
                    }).observe(root, { childList: true, subtree: true });
                  };
                  if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', observeRoot, { once: true });
                  } else {
                    observeRoot();
                  }
                  setTimeout(() => {
                    const root = document.getElementById('root');
                    const moduleScript = document.querySelector('script[type="module"][src]');
                    report(
                      'info',
                      'ready=' + document.readyState
                        + ' rootChildren=' + (root?.childElementCount ?? -1)
                        + ' bodyChildren=' + document.body.childElementCount
                        + ' moduleSrc=' + (moduleScript?.src || 'missing'),
                    );
                    const portal = document.querySelector('body > .fixed.inset-0');
                    if (portal) {
                      const style = getComputedStyle(portal);
                      const rect = portal.getBoundingClientRect();
                      report(
                        'info',
                        'portal opacity=' + style.opacity
                          + ' display=' + style.display
                          + ' visibility=' + style.visibility
                          + ' rect=' + rect.width + 'x' + rect.height
                          + ' text=' + (portal.textContent || '').slice(0, 160),
                      );
                    } else {
                      report(
                        'info',
                        'portal missing bodyHtml=' + document.body.innerHTML.slice(0, 500),
                      );
                    }
                  }, 3000);
                })();
                "#,
            );
        }
    });

    // 单实例锁（审阅 34 P1-2，2026-07-08）：防止双开进程共享同一套
    // SQLite/数据空间（A/B 切换标记、周期自动化调度器、更新器均不可重入）。
    // 官方要求该插件必须最先注册；仅桌面端启用。
    // 第二个实例启动时，把已有实例的主窗口带到前台。
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = if std::env::var_os("TAURI_LAB_INSTANCE_ID").is_some() {
        // tauri-lab isolates HOME, bundle id, device id, and metrics per instance.
        // The plugin keys its lock from the compiled Tauri identifier, so it would
        // otherwise collapse every isolated E2E instance into the production app.
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
    };

    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    return;
                }
                // 当前应用只注册了快速学习这一个全局快捷键；toggle 内部
                // 会校验 enabled 设置，关闭后按键不再有任何响应。
                crate::quick_assistant::toggle(app);
            })
            .build(),
    );

    // 桌面端专用：自动更新 + 进程管理（仅 macOS/Windows/Linux）
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // 🔧 MCP 调试插件（通过 mcp-debug feature 启用）
    // 使用 hypothesi/mcp-server-tauri 桥接插件
    // 允许 AI 代理（如 Cursor）通过 MCP 协议与应用交互
    // 功能：截图、DOM 快照、IPC 监控、输入模拟、控制台日志流、JS 执行
    // 文档：https://hypothesi.github.io/mcp-server-tauri
    // 启用方式：cargo run --features mcp-debug
    #[cfg(feature = "mcp-debug")]
    {
        use tauri_plugin_mcp_bridge;
        use tracing::info;

        info!("🔧 [MCP Debug] mcp-debug feature enabled, initializing tauri-plugin-mcp-bridge");

        // hypothesi 的桥接插件使用 WebSocket 通信（默认端口 9223）
        // MCP 服务器会自动连接到这个端口
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());

        info!("🔧 [MCP Debug] tauri-plugin-mcp-bridge initialized successfully");
    }

    // 🆕 数据治理命令（2026-01-30）
    // 条件编译：仅在启用 data_governance feature 时注册
    // 功能：Schema 注册表查询、审计日志、迁移状态、健康检查、备份管理
    // 注意：直接在 invoke_handler 中注册，不使用插件方式（避免权限配置复杂性）
    #[cfg(feature = "data_governance")]
    {
        use tracing::info;
        info!("🔧 [DataGovernance] 数据治理命令将在 invoke_handler 中注册");
    }

    let mut log_plugin_builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("deep-student".to_string()),
        }))
        .max_file_size(10 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log::LevelFilter::Info)
        .level_for("lance", log::LevelFilter::Warn)
        .level_for("lance_encoding", log::LevelFilter::Warn)
        .level_for("lance_io", log::LevelFilter::Warn)
        .level_for("tracing", log::LevelFilter::Warn)
        .level_for("h2", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("deep_student_lib", log::LevelFilter::Info);

    // Webview 回显只能用于开发构建；生产环境开启会与前端 console 捕获形成回路。
    #[cfg(debug_assertions)]
    {
        log_plugin_builder = log_plugin_builder
            .target(Target::new(TargetKind::Stdout))
            .target(Target::new(TargetKind::Webview));
    }

    builder
        .plugin(log_plugin_builder.build())
        //.manage(init_app_state())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 设置全局 AppHandle，用于在任意位置发送事件
            set_global_app_handle(app_handle.clone());

            // 运行最早阶段的容错：即使系统路径解析失败，也要能够初始化崩溃日志目录，避免静默闪退
            let base_app_data_dir = app_handle
                .path()
                .app_data_dir()
                .unwrap_or_else(|e| {
                    // 回退到临时目录（记录具体错误原因）
                    let fallback = std::env::temp_dir().join("deep-student");
                    warn!(
                        "[startup] 获取应用数据目录失败: {}，使用临时目录: {}",
                        e,
                        fallback.display()
                    );
                    let _ = std::fs::create_dir_all(&fallback);
                    fallback
                });

            // 所有可反馈日志统一到系统推荐日志目录：
            // macOS ~/Library/Logs/<identifier>，Windows %LOCALAPPDATA%/<identifier>/logs。
            let app_log_dir = app_handle.path().app_log_dir().unwrap_or_else(|e| {
                let fallback = base_app_data_dir.join("logs");
                warn!(
                    "[startup] 获取系统日志目录失败: {}，使用应用数据目录回退: {}",
                    e,
                    fallback.display()
                );
                fallback
            });
            if let Err(e) = std::fs::create_dir_all(&app_log_dir) {
                error!(
                    "[startup] 创建系统日志目录失败（结构化日志将尝试降级写入）: {}",
                    e
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(e) = std::fs::set_permissions(
                    &app_log_dir,
                    std::fs::Permissions::from_mode(0o700),
                ) {
                    warn!("[startup] 收紧日志目录权限失败: {}", e);
                }
            }

            // 初始化崩溃日志（即使后续仍有致命错误，也能落盘）
            crate::crash_logger::init_crash_logging(app_log_dir.clone());

            // 启动异步运行时看门狗（所有平台）。
            // 注意：心跳跑在 tokio runtime 上，检测的是 tokio worker 饥饿
            // （如全局锁风暴导致所有 invoke 停摆），不是 UI 主线程 ANR，
            // 详见 anr_watchdog.rs 模块文档（审阅 19 P2-1 修正）。
            crate::anr_watchdog::start_anr_watchdog();

            // 定期发送心跳以驱动运行时饥饿检测
            tauri::async_runtime::spawn(async {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
                loop {
                    interval.tick().await;
                    crate::anr_watchdog::heartbeat();
                }
            });

            if let Err(e) = std::fs::create_dir_all(&base_app_data_dir) {
                error!(
                    "[startup] 创建应用数据目录失败（将继续以降级模式运行）: {}",
                    e
                );
            }

            // 注意（审阅 34 P1-1 / 19 P1-1，2026-07-08）：
            // WebView2 参数必须走 tauri.windows.conf.json 的 additionalBrowserArgs；
            // Wry 会覆盖 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，setup 阶段设置也已过晚。
            // RUST_BACKTRACE / RUST_LOG 已移至 run() 开头（真正的单线程阶段）。
            // ANTI-REGRESSION：勿在此 set_var WEBVIEW2_* 注入 --disable-gpu*；见 windows conf。

            // 初始化数据空间管理器（A/B 双数据空间）并应用 pending 切换
            if let Err(e) = crate::data_space::init_data_space_manager(base_app_data_dir.clone()) {
                error!(
                    "[startup] 数据空间初始化失败，拒绝在可能不完整的数据槽上继续启动: {}",
                    e
                );
                return Err(Box::new(e));
            }
            let data_space = crate::data_space::get_data_space_manager()
                .expect("DataSpaceManager not initialized");
            let active_app_data_dir = data_space.active_dir();
            if let Err(e) = std::fs::create_dir_all(&active_app_data_dir) {
                error!(
                    "[startup] 创建活动数据目录失败（将继续以降级模式运行）: {}",
                    e
                );
            }
            // 上次进程若在虚拟 URI 复制阶段崩溃，临时 ZIP 可能包含完整用户数据；
            // 新进程启动时没有可恢复任务所有权，必须主动清理。
            let stale_zip_exports = active_app_data_dir.join("temp_zip_export");
            if stale_zip_exports.exists() {
                if let Err(e) = std::fs::remove_dir_all(&stale_zip_exports) {
                    warn!(
                        "[startup] 清理遗留 ZIP 临时导出目录失败 {}: {}",
                        stale_zip_exports.display(),
                        e
                    );
                }
            }

            // 移动端兜底：将 TMP/TEMP 等变量设置到活动数据目录的 tmp/ 下，避免 Lance/Arrow 产生跨挂载点临时文件
            // SAFETY: std::env::set_var 在此处于应用启动的单线程初始化阶段调用，
            // 尚未创建 tokio/rayon 等工作线程，因此不存在多线程竞争。
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                let mobile_tmp = active_app_data_dir.join("tmp");
                let _ = std::fs::create_dir_all(&mobile_tmp);
                std::env::set_var("TMPDIR", &mobile_tmp);
                std::env::set_var("TEMP", &mobile_tmp);
                std::env::set_var("TMP", &mobile_tmp);
                std::env::set_var("ARROW_TMP_DIR", &mobile_tmp);
                std::env::set_var("LANCEDB_TMPDIR", &mobile_tmp);
            }

            // 在任何数据库初始化之前，执行启动阶段清理（若存在清理标记）
            if crate::startup_cleanup::should_purge_on_start(&base_app_data_dir) {
                match crate::startup_cleanup::purge_all_local_data(
                    &base_app_data_dir,
                    &active_app_data_dir,
                ) {
                    Ok(report) => {
                        info!("启动阶段已执行数据清理:\n{}", report.details);
                        if report.had_errors {
                            let error = std::io::Error::other(
                                "启动阶段数据清理不完整，已保留清理标记并拒绝打开业务库",
                            );
                            error!("{}", error);
                            return Err(Box::new(error));
                        }
                        if let Err(e) =
                            crate::startup_cleanup::clear_purge_marker(&base_app_data_dir)
                        {
                            error!("清除清理标记失败，拒绝打开业务库: {}", e);
                            return Err(Box::new(e));
                        }
                    }
                    Err(e) => {
                        error!("启动阶段数据清理失败: {}", e);
                        return Err(Box::new(e));
                    }
                }
            }

            // 初始化全局调试日志记录器
            crate::debug_logger::init_global_logger(app_log_dir);
            crate::debug_logger::start_periodic_flush();

            // 启动内置 Prometheus 指标服务
            crate::metrics_server::ensure_metrics_server(&app_handle);

            // 🆕 数据治理系统初始化（2026-01-30）
            // 条件编译：仅在启用 data_governance feature 时执行
            // 功能：迁移协调、审计日志、Schema 聚合
            #[cfg(feature = "data_governance")]
            let mut data_governance_init_failed = false;
            #[cfg(feature = "data_governance")]
            {
                use tracing::{info, warn};

                info!("🔧 [DataGovernance] 开始初始化数据治理系统...");

                // 审计健康状态（用于前端识别审计失真）
                let audit_health_state = std::sync::Arc::new(
                    crate::data_governance::commands::AuditHealthState::default(),
                );
                app.manage(audit_health_state);

                match crate::data_governance::initialize_with_report(&active_app_data_dir) {
                    Ok(result) => {
                        let report = &result.report;

                        if report.is_fully_successful() {
                            info!(
                                "✅ [DataGovernance] 初始化完成: 全局版本={}, 迁移数={}, 耗时={}ms",
                                result.registry.global_version,
                                report.migrations_applied,
                                report.total_duration_ms
                            );

                            // 迁移成功：清除之前可能持久化的错误文件
                            crate::data_governance::commands::clear_migration_error(&active_app_data_dir);

                            // 🆕 发送迁移成功事件到前端
                            let empty_warnings: Vec<String> = Vec::new();
                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": true,
                                "global_version": result.registry.global_version,
                                "migrations_applied": report.migrations_applied,
                                "duration_ms": report.total_duration_ms,
                                "warnings": empty_warnings
                            }));
                        } else {
                            // 有警告但仍可继续
                            warn!(
                                "⚠️ [DataGovernance] 初始化完成但有警告: 迁移数={}, 警告={:?}",
                                report.migrations_applied,
                                report.warnings
                            );

                            // 🆕 发送迁移警告事件到前端
                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": true,
                                "global_version": result.registry.global_version,
                                "migrations_applied": report.migrations_applied,
                                "duration_ms": report.total_duration_ms,
                                "warnings": report.warnings,
                                "has_warnings": true
                            }));
                        }

                        // 将 SchemaRegistry 注册到可变共享 State（供后续实时刷新）
                        let registry_arc =
                            std::sync::Arc::new(std::sync::RwLock::new(result.registry));
                        app.manage(registry_arc);
                        info!("✅ [DataGovernance] SchemaRegistry 已注册为 Tauri State");

                        // 将审计数据库注册到 Tauri State（供审计日志查询）
                        if let Some(audit_db) = result.audit_db {
                            let audit_db_arc = std::sync::Arc::new(audit_db);
                            app.manage(audit_db_arc);
                            info!("✅ [DataGovernance] AuditDatabase 已注册为 Tauri State");
                        } else {
                            // 即使审计数据库初始化失败，也创建一个默认的
                            warn!("⚠️ [DataGovernance] 审计数据库未初始化，创建默认实例...");
                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                // 初始化表结构
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                                info!("✅ [DataGovernance] 默认 AuditDatabase 已注册为 Tauri State");
                            } else if let Some(audit_health) = app.try_state::<std::sync::Arc<crate::data_governance::commands::AuditHealthState>>() {
                                audit_health.record_failure("审计数据库初始化失败，默认实例创建失败");
                            }
                        }

                        match crate::data_governance::commands_restore::finalize_restore_activation(
                            &active_app_data_dir,
                        ) {
                            Ok(true) => info!("✅ [DataGovernance] 恢复槽激活事务已提交"),
                            Ok(false) => {}
                            Err(error) => {
                                data_governance_init_failed = true;
                                crate::data_governance::commands::persist_migration_error(
                                    &active_app_data_dir,
                                    &error,
                                );
                                let _ = app_handle.emit(
                                    "data-governance-migration-status",
                                    serde_json::json!({
                                        "success": false,
                                        "error": error,
                                        "degraded_mode": true,
                                        "maintenance_mode_forced": true,
                                        "restore_activation_failed": true
                                    }),
                                );
                                warn!("恢复槽激活事务提交失败，强制进入维护模式");
                            }
                        }
                    }
                    Err(e) => {
                        let error_msg = e.to_string();

                        let is_recovered = matches!(
                            &e,
                            crate::data_governance::DataGovernanceError::Migration(
                                crate::data_governance::migration::MigrationError::RecoveredFromBackup { .. }
                            )
                        );

                        if is_recovered {
                            warn!(
                                "⚠️ [DataGovernance] 迁移失败已自动恢复到迁移前状态，以旧版 schema 启动: {}",
                                error_msg
                            );

                            crate::data_governance::commands::persist_migration_error(&active_app_data_dir, &error_msg);

                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": false,
                                "recovered": true,
                                "error": error_msg,
                                "maintenance_mode_forced": true,
                                "message": "数据库升级失败，已恢复到升级前状态并进入只读维护模式。请先导出备份或更新应用后重试。"
                            }));

                            let coordinator = crate::data_governance::MigrationCoordinator::new(active_app_data_dir.clone());
                            match coordinator.aggregate_schema_registry() {
                                Ok(registry) => {
                                    info!(
                                        "✅ [DataGovernance] 恢复后 Schema 聚合完成: 全局版本={}",
                                        registry.global_version
                                    );
                                    let registry_arc =
                                        std::sync::Arc::new(std::sync::RwLock::new(registry));
                                    app.manage(registry_arc);
                                }
                                Err(agg_err) => {
                                    warn!(
                                        "⚠️ [DataGovernance] 恢复后 Schema 聚合失败，使用空 Registry: {}",
                                        agg_err
                                    );
                                    let empty_registry = crate::data_governance::schema_registry::SchemaRegistry::default();
                                    let registry_arc =
                                        std::sync::Arc::new(std::sync::RwLock::new(empty_registry));
                                    app.manage(registry_arc);
                                }
                            }

                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                            }
                            // 新二进制不能在未声明兼容的旧 schema 上继续业务写入。
                            // 保持应用可启动以便诊断/导出，但进入 fail-close 维护模式。
                            data_governance_init_failed = true;
                        } else {
                            warn!("⚠️ [DataGovernance] 初始化失败（将以降级模式继续运行）: {}", error_msg);
                            warn!(
                                error = %e,
                                "数据治理系统初始化失败，应用将以降级模式继续运行"
                            );
                            data_governance_init_failed =
                                crate::data_governance::should_force_maintenance_mode_on_init_failure(&e);

                            crate::data_governance::commands::persist_migration_error(&active_app_data_dir, &error_msg);

                            let _ = app_handle.emit("data-governance-migration-status", serde_json::json!({
                                "success": false,
                                "error": error_msg,
                                "degraded_mode": true,
                                "maintenance_mode_forced": data_governance_init_failed
                            }));

                            let empty_registry = crate::data_governance::schema_registry::SchemaRegistry::default();
                            let registry_arc =
                                std::sync::Arc::new(std::sync::RwLock::new(empty_registry));
                            app.manage(registry_arc);
                            warn!("⚠️ [DataGovernance] 已注册空的 SchemaRegistry（降级模式）");

                            let audit_db_path = active_app_data_dir.join("databases").join("audit.db");
                            if let Ok(default_audit_db) = crate::data_governance::audit::AuditDatabase::open(&audit_db_path) {
                                let _ = default_audit_db.init();
                                let audit_db_arc = std::sync::Arc::new(default_audit_db);
                                app.manage(audit_db_arc);
                                info!("✅ [DataGovernance] 默认 AuditDatabase 已注册为 Tauri State");
                            } else if let Some(audit_health) = app.try_state::<std::sync::Arc<crate::data_governance::commands::AuditHealthState>>() {
                                audit_health.record_failure("审计数据库初始化失败，默认实例创建失败");
                            }
                        }
                    }
                }
            }

            // 构建并注册全局 AppState（使用当前活动的数据空间目录）
            let state = build_app_state(active_app_data_dir.clone(), app_handle.clone());
            let sentry_consented = state
                .database
                .get_setting("sentry_error_reporting_enabled")
                .ok()
                .flatten()
                .is_some_and(|value| value == "true");
            let sentry_guard = if sentry_consented {
                init_backend_sentry_client()
            } else {
                None
            };
            app.manage(BackendSentryState(std::sync::Arc::new(
                std::sync::Mutex::new(sentry_guard),
            )));
            app.manage(state);


            // 数据治理初始化失败时进入维护模式，阻断写入路径
            #[cfg(feature = "data_governance")]
            {
                if data_governance_init_failed {
                    let app_state: tauri::State<crate::commands::AppState> = app.state();
                    let maintenance_result = (|| -> Result<(), String> {
                        app_state
                            .database
                            .enter_maintenance_mode()
                            .map_err(|e| format!("主数据库: {}", e))?;
                        app_state
                            .database_manager
                            .enter_maintenance_mode()
                            .map_err(|e| format!("数据库连接池: {}", e))?;
                        if let Some(vfs) = &app_state.vfs_db {
                            vfs.enter_maintenance_mode()
                                .map_err(|e| format!("VFS: {}", e))?;
                        }
                        if let Some(chat) =
                            app.try_state::<std::sync::Arc<crate::chat_v2::ChatV2Database>>()
                        {
                            chat.enter_maintenance_mode()
                                .map_err(|e| format!("Chat V2: {}", e))?;
                        }
                        if let Some(usage) =
                            app.try_state::<std::sync::Arc<crate::llm_usage::LlmUsageDatabase>>()
                        {
                            usage
                                .enter_maintenance_mode()
                                .map_err(|e| format!("LLM Usage: {}", e))?;
                        }
                        if let Some(workspaces) = app.try_state::<std::sync::Arc<
                            crate::chat_v2::workspace::WorkspaceCoordinator,
                        >>() {
                            workspaces
                                .enter_maintenance_mode()
                                .map_err(|e| format!("工作区: {}", e))?;
                        }
                        Ok(())
                    })();
                    if let Err(e) = maintenance_result {
                        tracing::error!(error = %e, "数据治理初始化失败后无法建立完整维护屏障");
                        return Err(Box::new(std::io::Error::other(format!(
                            "无法建立完整数据治理维护屏障: {}",
                            e
                        ))));
                    }
                    tracing::warn!("⚠️ [DataGovernance] 初始化失败后已进入全组件维护模式");
                }
            }

            // 在 Tokio 运行时中启动消息处理器并注册处理器
            // Retrieve the application state and clone the database from it
            let app_state: tauri::State<crate::commands::AppState> = app.state();
            let database = app_state.inner().database.clone();
            // 兼容命令注入：部分命令直接请求 `State<Arc<Database>>`（例如 schedule_memory_internalization）
            // 需要显式将 `Arc<Database>` 注入到 Tauri 状态中，否则会提示 `.manage()` 缺失
            app.manage(database.clone());

            // 🆕 注册 BackupJobManagerState 为 Tauri State（单例模式）
            // 所有备份相关命令都应通过 State 注入获取管理器实例
            #[cfg(feature = "data_governance")]
            {
                use tracing::info;
                use crate::backup_job_manager::BackupJobManagerState;

                let backup_job_manager_state = BackupJobManagerState::new(app_handle.clone());

                // 检查是否有可恢复的备份任务
                if let Ok(resumable) = backup_job_manager_state.inner().list_resumable_jobs() {
                    if !resumable.is_empty() {
                        info!(
                            "🔄 [Backup] 发现 {} 个可恢复的备份任务",
                            resumable.len()
                        );
                        // 发送事件通知前端有可恢复的任务
                        let _ = app_handle.emit("backup-jobs-resumable", &resumable);
                    }
                }
                // 清理已完成任务的持久化文件
                let _ = backup_job_manager_state.inner().cleanup_finished_persisted_jobs();

                // 注册为 Tauri State
                app.manage(backup_job_manager_state);
                info!("✅ [Backup] BackupJobManagerState 已注册为 Tauri State（单例模式）");
            }

            // 数据治理 fail-close 时不得再初始化会打开/写入磁盘的新数据库组件。
            #[cfg(feature = "data_governance")]
            let initialize_extended_databases = !data_governance_init_failed;
            #[cfg(not(feature = "data_governance"))]
            let initialize_extended_databases = true;
            if initialize_extended_databases {
                // 初始化 Chat V2（使用统一初始化函数）
                match crate::chat_v2::init_chat_v2(&active_app_data_dir) {
                Ok(chat_v2_db) => {
                    info!("✅ Chat V2 统一初始化完成: {}", chat_v2_db.db_path().display());
                    let chat_v2_db_arc = std::sync::Arc::new(chat_v2_db);
                    app.manage(chat_v2_db_arc.clone());

                    // 🆕 先初始化 ApprovalManager（用于敏感工具审批，文档 29 P1-3）
                    // 必须在 Pipeline 之前创建，以便 Pipeline 关联
                    let approval_manager = std::sync::Arc::new(crate::chat_v2::approval_manager::ApprovalManager::new());
                    app.manage(approval_manager.clone());
                    info!("✅ Chat V2 ApprovalManager 初始化成功");

                    // 🔧 P0 修复：先初始化 WorkspaceCoordinator，再传入 Pipeline
                    // 这样 Pipeline 才能注册 WorkspaceToolExecutor 和 SubagentExecutor
                    let workspaces_dir = active_app_data_dir.join("workspaces");
                    std::fs::create_dir_all(&workspaces_dir).ok();
                    let workspace_coordinator = std::sync::Arc::new(
                        crate::chat_v2::workspace::WorkspaceCoordinator::new(workspaces_dir)
                            .with_chat_v2_db(chat_v2_db_arc.clone()) // 关联主数据库以同步 workspace_index
                            .with_app_handle(app_handle.clone()) // 关联 AppHandle 以发射事件到前端
                    );
                    app.manage(workspace_coordinator.clone());
                    info!("✅ Chat V2 WorkspaceCoordinator 初始化成功");

                    let vfs_db_arc_opt = app_state.inner().vfs_db.clone();

                    // 初始化 Chat V2 Pipeline（用于消息处理流水线）
                    // 传入主数据库，让工具调用可以读取用户配置
                    // 传入 NotesManager，让 Canvas 工具可以操作笔记
                    // 🆕 传入 vfs_db，用于统一资源库（检索结果存储等）
                    // 🆕 使用 with_approval_manager 关联审批管理器（文档 29 P1-3）
                    // 🆕 使用 with_workspace_coordinator 关联工作区协调器（文档 30）
                    // 与 builder 级 ChatV2State 共享 Kill Switch，使 tool_loop 断电优先于会话档位
                    let chat_v2_kill_switch = app
                        .state::<std::sync::Arc<crate::chat_v2::ChatV2State>>()
                        .kill_switch
                        .clone();
                    let chat_v2_pipeline = std::sync::Arc::new(
                        crate::chat_v2::pipeline::ChatV2Pipeline::new(
                            chat_v2_db_arc.clone(),
                            Some(database.clone()), // 主数据库，用于工具读取用户配置
                            Some(app_state.inner().anki_database.clone()), // Anki 数据库，用于制卡进度查询
                            vfs_db_arc_opt.clone(), // VFS 统一资源库
                            app_state.inner().llm_manager.clone(),
                            std::sync::Arc::new(crate::tools::ToolRegistry::new_with(vec![
                                std::sync::Arc::new(crate::tools::WebSearchTool) as std::sync::Arc<dyn crate::tools::Tool>,
                            ])),
                            Some(app_state.inner().notes_manager.clone()), // NotesManager
                        )
                        .with_approval_manager(approval_manager) // 🆕 关联审批管理器
                        .with_kill_switch(chat_v2_kill_switch) // 🆕 工具环共享一键断电
                        .with_workspace_coordinator(workspace_coordinator) // 🆕 关联工作区协调器
                        .with_pdf_processing_service(app_state.inner().pdf_processing_service.clone()) // 🆕 论文保存触发 Pipeline
                    );
                    let recovery_pipeline = chat_v2_pipeline.clone();
                    tauri::async_runtime::spawn(async move {
                        recovery_pipeline.recover_pending_memory_flushes().await;
                    });
                    app.manage(chat_v2_pipeline);
                    info!("✅ Chat V2 Pipeline 初始化成功（已启用敏感工具审批、工作区协作）");
                }
                Err(e) => {
                    error!("⚠️ Chat V2 数据库初始化失败（将以降级模式继续运行）: {}", e);
                    // 不阻止应用启动，但 Chat V2 功能将不可用
                }
                }

                // 初始化 LLM Usage 统计数据库
                match crate::llm_usage::LlmUsageDatabase::new(&active_app_data_dir) {
                Ok(llm_usage_db) => {
                    info!("✅ LLM Usage 数据库初始化完成: {}", llm_usage_db.db_path().display());
                    let llm_usage_db_arc = std::sync::Arc::new(llm_usage_db);
                    app.manage(llm_usage_db_arc.clone());

                    let collector = std::sync::Arc::new(crate::llm_usage::UsageCollector::new(llm_usage_db_arc));
                    app.manage(collector);
                    info!("✅ LLM Usage Collector 初始化成功");
                }
                Err(e) => {
                    error!("⚠️ LLM Usage 数据库初始化失败（统计功能将不可用）: {}", e);
                }
                }
            } else {
                warn!("⚠️ [DataGovernance] fail-close 模式下已跳过 Chat V2 与 LLM Usage 数据库初始化");
            }

            // Workbench 内置浏览器：manage 未打开的 DB + Service（不无条件 ensure_open）
            {
                let browser_db = std::sync::Arc::new(crate::browser::BrowserDatabase::new(
                    active_app_data_dir.clone(),
                ));
                let browser_svc =
                    crate::browser::BrowserService::new(app_handle.clone(), browser_db);
                crate::browser::BrowserService::boot_cleanup(&app_handle);
                app.manage(browser_svc);
                info!("✅ BrowserService 已注册（lazy DB；boot_cleanup 已扫孤儿窗）");
            }

            // 初始化 MCP 客户端（已熔断后端模式；仅当 mcp.mode=backend 时才初始化）
            #[cfg(feature = "mcp")]
            {
                let database_for_mcp = database.clone();
                let app_handle_for_mcp = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mode = database_for_mcp.get_setting("mcp.mode").ok().flatten().unwrap_or_else(|| "frontend".to_string());
                    if mode == "backend" {
                        if let Err(e) = init_mcp_client(database_for_mcp, Some(app_handle_for_mcp)).await {
                            error!("❌ MCP 客户端初始化失败: {}", e);
                        } else {
                            info!("✅ MCP 客户端初始化成功");
                        }
                    } else {
                        info!("🔧 [MCP] 后端MCP已禁用(mode={}),使用前端SDK", mode);
                    }
                });
            }


            // 启动后异步触发一次 Lance 聊天表与遗留 KB 宽表的轻量优化
            // （压缩合并+清理近期旧版本+索引优化）
            {
                let database_for_maint = database.clone();
                tauri::async_runtime::spawn(async move {
                    // 避免与首屏渲染争用资源，延迟一小段时间再执行后台优化
                    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                    if let Ok(store) = crate::lance_vector_store::LanceVectorStore::new(database_for_maint.clone()) {
                        let _ = store.optimize_chat_tables(Some(7), None, false).await; // 默认清理 >7 天版本
                        let _ = store.optimize_kb_tables(Some(7), None, false).await; // KB 宽表同样吞错，不影响启动
                    }
                });
            }

            // ★ 断点续导：启动时恢复中断的导入会话
            {
                let llm_mgr = app_state.inner().llm_manager.clone();
                let file_mgr = app_state.inner().file_manager.clone();
                let vfs_db_opt = app_state.inner().vfs_db.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(vfs_db) = vfs_db_opt {
                        let import_service = crate::question_import_service::QuestionImportService::new(llm_mgr, file_mgr);
                        match import_service.recover_importing_sessions(&vfs_db).await {
                            Ok(resumable) if !resumable.is_empty() => {
                                info!("[QuestionImport] {} 个可恢复的导入会话待用户操作", resumable.len());
                            }
                            Ok(_) => {}
                            Err(e) => {
                                warn!("[QuestionImport] 启动恢复检查失败: {}", e);
                            }
                        }
                    }
                });
            }

            // 自动备份定时调度器
            {
                let database_for_backup = database.clone();
                let database_manager_for_backup = app_state.inner().database_manager.clone();
                let file_manager_for_backup = app_state.inner().file_manager.clone();
                let app_handle_for_backup = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    crate::backup_config::start_auto_backup_scheduler(
                        app_handle_for_backup,
                        database_for_backup,
                        database_manager_for_backup,
                        file_manager_for_backup,
                    ).await;
                });
            }

            // 周期自动化调度器
            {
                let database_for_automation = database.clone();
                let vfs_db_for_automation = app_state.inner().vfs_db.clone();
                let app_handle_for_automation = app_handle.clone();
                crate::background_tasks::spawn(async move {
                    crate::chat_v2::automations::start_automation_scheduler(
                        database_for_automation,
                        vfs_db_for_automation,
                        app_handle_for_automation,
                    )
                    .await;
                });
            }

            // 有启用自动化时，用户关闭主窗口默认转为后台驻留。应用仍可通过
            // Dock/任务栏再次启动；single-instance 回调会唤回这一窗口。显式“退出”
            // 仍走 RunEvent::ExitRequested，不拦截。
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                let database_for_close = database.clone();
                let window_for_close = window.clone();
                let app_for_close = app_handle.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let keep_quick_assistant_background = database_for_close
                            .get_setting("quick_assistant.background_enabled")
                            .ok()
                            .flatten()
                            .as_deref()
                            == Some("true");
                        if !crate::chat_v2::automations::automation_app_is_exiting()
                            && (crate::chat_v2::automations::should_keep_automation_background(
                                &database_for_close,
                            ) || keep_quick_assistant_background)
                        {
                            api.prevent_close();
                            let _ = window_for_close.hide();
                            // 「从不通知」档全局生效：后台驻留提示同样受
                            // 统一策略约束（background/always 档照常提示）。
                            if !crate::system_notification::notifications_disabled(
                                &database_for_close,
                            ) {
                                use tauri_plugin_notification::NotificationExt;
                                let _ = app_for_close
                                    .notification()
                                    .builder()
                                    .title("Deep Student 正在后台运行")
                                    .body("已启用的定时任务会继续按计划执行。")
                                    .show();
                            }
                        } else if !crate::chat_v2::automations::automation_app_is_exiting() {
                            #[cfg(target_os = "macos")]
                            {
                                // macOS keeps the process alive after the last
                                // window closes. Background residency being off
                                // therefore means "close quits", otherwise
                                // headless jobs would retain a windowless app.
                                crate::chat_v2::automations::mark_automation_app_exiting();
                                app_for_close.exit(0);
                            }
                        }
                    }
                });
            }

            // 快速学习小窗预加载：设置开启时提前建好隐藏窗口，
            // 首次快捷键呼出即刻显示，无现场创建的白窗延迟。
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            crate::quick_assistant::preload_if_enabled(&app_handle);

            // macOS 窗口圆角设置
            #[cfg(target_os = "macos")]
            {
                // 安装 macOS 原生菜单栏（Phase D2 of native-feel migration, 2026-05-14）
                if let Err(e) = crate::menu::install_menu(&app_handle) {
                    error!("[setup] 安装 macOS 菜单栏失败: {}", e);
                }

                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    info!("[setup] 主窗口已创建，准备显示并聚焦");
                    if let Err(e) = window.show() {
                        warn!("[setup] 显示主窗口失败: {}", e);
                    }
                    if let Err(e) = window.set_focus() {
                        warn!("[setup] 聚焦主窗口失败: {}", e);
                    }

                    let standard_window_for_e2e = std::env::var("DSTU_E2E_STANDARD_WINDOW")
                        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                        .unwrap_or(false);

                    // 使用虚拟标题栏：内容延伸到窗口顶部，隐藏原生标题文字，保留左侧红黄绿按钮。
                    // E2E 实例也必须使用相同 chrome，否则真实截图会额外出现一整行系统标题栏。
                    #[allow(unused_unsafe)]
                    #[allow(unexpected_cfgs)] // objc::msg_send! 宏内部使用 cfg(feature = "cargo-clippy")
                    unsafe {
                        use cocoa::appkit::{
                            NSApp, NSApplication, NSWindowStyleMask, NSWindowTitleVisibility,
                        };
                        use cocoa::base::{id, nil, NO, YES};
                        use objc::{msg_send, sel, sel_impl};

                        if let Ok(ns_window_raw) = window.ns_window() {
                            let ns_window = ns_window_raw as id;
                            let _: () = msg_send![ns_window, setStyleMask:
                                NSWindowStyleMask::NSTitledWindowMask
                                | NSWindowStyleMask::NSClosableWindowMask
                                | NSWindowStyleMask::NSMiniaturizableWindowMask
                                | NSWindowStyleMask::NSResizableWindowMask
                                | NSWindowStyleMask::NSFullSizeContentViewWindowMask
                            ];
                            let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: YES];
                            let _: () = msg_send![ns_window, setTitleVisibility: NSWindowTitleVisibility::NSWindowTitleHidden];
                            let _: () = msg_send![ns_window, setMovableByWindowBackground: NO];

                            if standard_window_for_e2e {
                                use cocoa::foundation::NSString;
                                let ax_window = NSString::alloc(nil).init_str("AXWindow");
                                let ax_standard_window =
                                    NSString::alloc(nil).init_str("AXStandardWindow");
                                let ax_title = NSString::alloc(nil).init_str("Deep Student");
                                let _: () = msg_send![ns_window, setAccessibilityElement: YES];
                                let _: () = msg_send![ns_window, setAccessibilityRole: ax_window];
                                let _: () =
                                    msg_send![ns_window, setAccessibilitySubrole: ax_standard_window];
                                let _: () = msg_send![ns_window, setAccessibilityTitle: ax_title];
                                let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
                                let _: () = msg_send![ns_window, orderFrontRegardless];
                                // tauri-lab 直接启动 bundle 内二进制，不经过 LaunchServices。
                                // 显式激活应用，确保窗口能接收真实鼠标/键盘事件。
                                let ns_app = NSApp();
                                ns_app.activateIgnoringOtherApps_(YES);
                                info!(
                                    "[setup] DSTU_E2E_STANDARD_WINDOW 已启用，沿用全尺寸 macOS 标题栏并补充可访问性窗口元数据"
                                );
                            }
                        } else {
                            warn!("获取 macOS NSWindow 失败，跳过窗口样式设置");
                        }
                    }
                } else {
                    warn!("[setup] 未找到 label=main 的主窗口");
                }
            }

            // Windows：WebView2 呈现位置自愈（2026-07-10 OS 模式整层错位事故）。
            // WebView2 把 Chromium 合成输出经 DirectComposition 呈现到宿主 HWND 的
            // 那一段，在 resize / 最大化 / 跨 DPI 显示器移动后偶发保持陈旧偏移：
            // 页面布局正确，但整个画面上/下错位（顶部黑条、Dock 画出窗框以下）。
            // NotifyParentWindowPositionChanged 是宿主侧标准自愈调用——强制
            // WebView2 重新计算相对宿主窗口的呈现位置与裁剪。幂等且极廉价，
            // 在聚焦 / 尺寸 / DPI 变化时各补一次。前端另有 useCompositorNudge
            // 做页面侧整面重绘，两层自愈相互独立（CI：platformPerformanceConfig）。
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let webview_for_refresh = window.clone();
                    window.on_window_event(move |event| {
                        use tauri::WindowEvent;
                        let should_refresh = matches!(
                            event,
                            WindowEvent::Focused(true)
                                | WindowEvent::Resized(_)
                                | WindowEvent::ScaleFactorChanged { .. }
                        );
                        if should_refresh {
                            let _ = webview_for_refresh.with_webview(|platform| {
                                let controller = platform.controller();
                                // SAFETY: with_webview 在 UI 线程回调；controller 由 wry
                                // 持有存活。该 COM 调用无出参、幂等，失败可安全忽略。
                                let _ = unsafe { controller.NotifyParentWindowPositionChanged() };
                            });
                        }
                    });
                }
            }

            Ok(())
        })
        // Provide ChatV2State for Chat V2 stream management (Arc wrapped for spawn usage)
        .manage(std::sync::Arc::new(crate::chat_v2::ChatV2State::new()))
        .manage(crate::secret_prompt::SecretPromptStore::default())
        // NOTE: ChatV2Pipeline is now initialized in setup() closure after AppState is available
        .invoke_handler(tauri::generate_handler![
            // =================================================
            // commands.rs
            // =================================================
            crate::pdfium_utils::test_pdfium_status,
            crate::commands::get_app_version,
            crate::commands::get_app_data_dir,
            crate::commands::process_pdf_ocr,
            crate::commands::init_pdf_ocr_session, // 🎯
            crate::commands::upload_pdf_ocr_page, // 🎯
            crate::commands::cancel_pdf_ocr_session,
            crate::commands::pause_pdf_ocr_session,
            crate::commands::resume_pdf_ocr_session,
            crate::commands::skip_pdf_ocr_page,
            // 🚀 后端驱动的 PDF OCR（高性能）
            crate::commands::start_pdf_ocr_backend,
            crate::commands::get_pdf_ocr_temp_dir,
            crate::commands::save_pdf_to_temp,
            crate::commands::list_exam_sheet_sessions,
            crate::commands::get_exam_sheet_session_detail,
            crate::commands::update_exam_sheet_cards,
            crate::commands::rename_exam_sheet_session,
            crate::commands::inspect_pdf_text_for_qbank,
            crate::commands::import_question_bank,
            crate::commands::import_question_bank_stream,
            crate::commands::cancel_question_bank_import,
            // 断点续导
            crate::commands::resume_question_import,
            crate::commands::list_importing_sessions,
            // 题目集原始图片管理
            crate::commands::qbank_get_source_images,
            crate::commands::qbank_crop_source_image,
            crate::commands::qbank_remove_question_image,
            // CSV 导入导出命令
            crate::commands::import_questions_csv,
            crate::commands::cancel_questions_csv_import,
            crate::commands::export_questions_csv,
            crate::commands::get_csv_preview,
            crate::commands::get_csv_exportable_fields,
            crate::commands::pin_images,
            crate::commands::unpin_images,

            crate::commands::get_enhanced_statistics,

            // 通用设置保存/读取命令
            crate::commands::save_setting,
            crate::commands::get_setting,
            crate::commands::delete_setting,
            crate::commands::get_settings_by_prefix,
            crate::commands::delete_settings_by_prefix,
            backend_sentry_command::set_backend_sentry_enabled,
            // 快速学习小窗窗口管理
            crate::quick_assistant::quick_assistant_show,
            crate::quick_assistant::quick_assistant_hide,
            crate::quick_assistant::quick_assistant_apply_enabled,
            crate::voice_input::voice_input_transcribe,
            crate::secret_prompt::secret_prompt_submit,
            crate::secret_prompt::secret_prompt_status,
            crate::secret_prompt::secret_prompt_discard,
            crate::secret_prompt::secret_prompt_capabilities,
            // 调试日志管理
            crate::commands::get_debug_logs_info,
            crate::commands::clear_debug_logs,
            crate::commands::cleanup_old_debug_logs,
            crate::commands::ensure_debug_log_dir,
            crate::commands::read_debug_log_file,
            crate::commands::get_security_status,
            crate::commands::get_cn_whitelist_config,
            crate::commands::detect_tool_conflicts,
            crate::commands::get_tools_namespace_config,
            crate::commands::get_provider_strategies_config,
            crate::commands::save_provider_strategies_config,
            crate::commands::get_feature_flags,
            crate::commands::update_feature_flag,
            crate::commands::is_feature_enabled,
            crate::commands::get_injection_budget_config,
            crate::commands::simulate_budget_allocation,
            crate::commands::test_search_engine,
            crate::commands::get_image_as_base64,
            crate::commands::get_api_configurations,
            crate::commands::save_api_configurations,
            crate::commands::get_model_assignments,
            crate::commands::save_model_assignments,
            // LLM Failover 策略（fallback 链 / key 轮换 / 用途分模型路由）
            crate::llm_manager::routing::llm_get_failover_policy,
            crate::llm_manager::routing::llm_set_failover_policy,
            crate::commands::get_vendor_configs,
            crate::commands::save_vendor_configs,
            crate::commands::fetch_vendor_models,
            crate::commands::get_model_profiles,
            crate::commands::save_model_profiles,
            crate::commands::test_api_connection,
            crate::cmd::openai_codex::openai_codex_auth_status,
            crate::cmd::openai_codex::openai_codex_login_start,
            crate::cmd::openai_codex::openai_codex_login_cancel,
            crate::cmd::openai_codex::openai_codex_logout,
            crate::cmd::openai_codex::openai_codex_usage,

            crate::commands::get_model_adapter_options,
            crate::commands::save_model_adapter_options,
            crate::commands::reset_model_adapter_options,
            crate::commands::estimate_tokens,
            // OCR 引擎配置命令
            crate::commands::get_ocr_engines,
            crate::commands::get_ocr_engine_type,
            crate::commands::set_ocr_engine_type,
            crate::commands::get_ocr_thinking_enabled,
            crate::commands::set_ocr_thinking_enabled,
            crate::commands::infer_ocr_engine_from_model,
            crate::commands::validate_ocr_model,
            crate::commands::get_ocr_prompt_template,
            crate::commands::get_available_ocr_models,
            crate::commands::save_available_ocr_models,
            crate::commands::test_ocr_engine,
            crate::commands::update_ocr_engine_priority,
            crate::commands::add_ocr_engine,
            crate::commands::remove_ocr_engine,
            // Lance 向量表优化命令
            crate::commands::optimize_chat_embeddings_table,
            crate::commands::clear_message_embeddings,
            crate::commands::generate_anki_cards_from_document,
            crate::commands::generate_anki_cards_from_document_file,
            crate::commands::generate_anki_cards_from_document_base64,
            crate::commands::call_llm_for_boundary, // CardForge 2.0 - LLM 定界
            crate::commands::check_anki_connect_status,
            crate::commands::get_anki_deck_names,
            crate::commands::get_anki_model_names,
            crate::commands::create_anki_deck,
            crate::commands::save_anki_cards,
            crate::commands::add_cards_to_anki_connect,
            crate::commands::import_anki_package,
            crate::commands::export_cards_as_apkg,
            crate::commands::export_cards_as_apkg_with_template,
            crate::cmd::anki_connect::export_multi_template_apkg,
            // 🔧 P0-30 修复：注册批量导出命令
            crate::commands::batch_export_cards,
            crate::commands::save_json_file,
            crate::commands::start_enhanced_document_processing,
            crate::commands::pause_document_processing,
            crate::commands::cancel_document_processing,
            crate::commands::resume_document_processing,
            crate::commands::get_document_processing_state,
            crate::commands::get_document_task_counts,
            crate::commands::trigger_task_processing,
            crate::commands::get_document_tasks,
            crate::commands::get_task_cards,
            crate::commands::update_anki_card,
            crate::commands::delete_anki_card,
            crate::commands::delete_document_task,
            crate::commands::delete_document_session,
            crate::commands::export_apkg_for_selection,
            crate::commands::get_document_cards,
            crate::commands::list_anki_library_cards,
            crate::commands::export_anki_cards,
            crate::cmd::enhanced_anki::recover_stuck_document_tasks,
            crate::cmd::enhanced_anki::list_document_sessions,
            crate::cmd::enhanced_anki::get_anki_stats,
            // ★ 4.2 防休眠（制卡等长任务）
            crate::cmd::power::set_prevent_sleep,
            crate::cmd::power::get_prevent_sleep,
            // 移动端支撑：图片压缩（上传前减载）+ 网络质量探测（弱网降级）
            crate::cmd::media::compress_image,
            crate::cmd::network::network_probe,
            // 状态恢复相关命令
            crate::commands::get_recent_document_tasks,
            crate::commands::get_all_recent_cards,
            crate::commands::get_pending_memory_candidates,
            crate::commands::dismiss_pending_memory_candidates,
            crate::commands::mark_pending_memory_candidates_saved,
            crate::commands::parse_document_from_path,
            crate::commands::parse_document_from_base64,
            // Translation Commands
            crate::translation::translate_text_stream,
            crate::translation::chat_popover::stream_chat_translation_aligned,
            crate::translation::chat_popover::stream_chat_translation_plain,
            crate::translation::candidates::translate_text_candidates,
            crate::translation::candidates::cancel_translation_candidates,
            crate::commands::ocr_extract_text,
            // Essay Grading Commands
            crate::essay_grading::essay_grading_stream,
            crate::essay_grading::essay_grading_create_session,
            crate::essay_grading::essay_grading_get_session,
            crate::essay_grading::essay_grading_update_session,
            crate::essay_grading::essay_grading_delete_session,
            crate::essay_grading::essay_grading_list_sessions,
            crate::essay_grading::essay_grading_toggle_favorite,
            crate::essay_grading::essay_grading_get_rounds,
            crate::essay_grading::essay_grading_get_round,
            crate::essay_grading::essay_grading_get_latest_round_number,
            crate::essay_grading::essay_grading_get_modes,
            crate::essay_grading::essay_grading_get_mode,
            crate::essay_grading::essay_grading_get_models,
            // 自定义批阅模式 CRUD
            crate::essay_grading::essay_grading_create_custom_mode,
            crate::essay_grading::essay_grading_update_custom_mode,
            crate::essay_grading::essay_grading_delete_custom_mode,
            crate::essay_grading::essay_grading_list_custom_modes,
            crate::essay_grading::essay_grading_save_builtin_override,
            crate::essay_grading::essay_grading_reset_builtin_mode,
            crate::essay_grading::essay_grading_has_builtin_override,
            // Qbank AI Grading Commands
            crate::qbank_grading::qbank_ai_grade,
            crate::qbank_grading::qbank_cancel_grading,
            // TTS Commands (optional fallback for Web Speech API)
            crate::tts::tts_check_available,
            crate::tts::tts_speak,
            crate::tts::tts_stop,
            crate::commands::read_file_text,
            crate::commands::get_file_size,
            crate::commands::pdfstream_check_access,
            crate::file_stream_protocol::filestream_check_access,
            crate::commands::hash_file,
            crate::commands::read_file_bytes,
            crate::commands::copy_file,
            crate::commands::save_text_to_file,
            crate::commands::get_all_custom_templates,
            crate::commands::get_custom_template_by_id,
            crate::commands::create_custom_template,
            crate::commands::update_custom_template,
            crate::commands::delete_custom_template,
            crate::commands::export_template,
            crate::commands::import_template,
            crate::commands::import_custom_templates_bulk,
            crate::commands::import_builtin_templates,
            crate::commands::set_default_template,
            crate::commands::get_default_template_id,
            crate::commands::save_test_log,
            crate::commands::get_test_logs,
            crate::commands::open_log_file,
            crate::commands::open_logs_folder,
            crate::system_permissions::open_system_permission_settings,
            crate::commands::report_frontend_log,
            crate::diagnostics::export_diagnostics_bundle,
            crate::commands::save_template_debug_data,
            crate::commands::export_unified_backup_data,
            // 备份配置
            crate::backup_config::get_backup_config,
            crate::backup_config::set_backup_config,
            crate::backup_config::pick_backup_directory,
            crate::backup_config::clear_backup_directory,
            crate::backup_config::get_default_backup_directory,
            // Cloud storage (unified WebDAV + S3 interface)
            crate::cloud_storage::cloud_storage_check_connection,
            crate::cloud_storage::cloud_storage_put,
            crate::cloud_storage::cloud_storage_get,
            crate::cloud_storage::cloud_storage_list,
            crate::cloud_storage::cloud_storage_delete,
            crate::cloud_storage::cloud_storage_stat,
            crate::cloud_storage::cloud_storage_exists,
            // Cloud sync manager (ZIP backup upload/download/versioning)
            crate::cloud_storage::cloud_sync_get_status,
            crate::cloud_storage::cloud_sync_list_versions,
            crate::cloud_storage::cloud_sync_upload,
            crate::cloud_storage::cloud_sync_download,
            crate::cloud_storage::cloud_sync_delete_version,
            crate::cloud_storage::cloud_sync_get_device_id,
            crate::cloud_storage::cloud_storage_is_s3_enabled,
            // Secure storage (cross-platform credential storage)
            crate::secure_store::secure_save_cloud_credentials,
            crate::secure_store::secure_get_cloud_credentials,
            crate::secure_store::secure_delete_cloud_credentials,
            crate::secure_store::secure_store_is_available,
            // AnkiConnect compatibility
            crate::commands::anki_get_deck_names,
            // =================================================
            // config_recovery.rs
            // =================================================
            crate::config_recovery::restore_default_api_configs,
            crate::config_recovery::check_api_config_status,
            // =================================================
            // debug_logger.rs
            // =================================================
            crate::debug_logger::write_debug_logs,
            // =================================================
            // debug_commands.rs - 调试专用直接数据库访问
            crate::debug_commands::debug_get_database_stats,
            crate::debug_commands::log_debug_message,
            crate::debug_commands::tauri_lab_frontend_log,
            crate::debug_commands::debug_vfs_migration_status,
            crate::debug_commands::debug_vfs_textbook_pages,
            // =================================================
            // Vector Index Management
            // =================================================
            crate::commands::optimize_lance_database,
            crate::commands::cancel_stream,
            // MCP 相关命令
            crate::commands::get_mcp_status,
            crate::commands::get_mcp_tools,
            crate::commands::test_mcp_connection,
            crate::commands::test_mcp_websocket,
            crate::commands::test_mcp_sse,
            crate::commands::test_mcp_http,
            crate::commands::mcp_stdio_start,
            crate::commands::mcp_stdio_send,
            crate::commands::mcp_stdio_close,
            crate::commands::save_mcp_config,
            crate::commands::reload_mcp_client,
            crate::commands::get_mcp_config,
            crate::commands::import_mcp_config,
            crate::commands::export_mcp_config,
            // 2026-06-12 补注册：设置页 MCP 编辑器与 mcpService 启动预热已在调用
            crate::commands::preheat_mcp_tools,
            #[cfg(not(target_os = "android"))]
            crate::mcp::commands::start_mcp_oauth,
            #[cfg(not(target_os = "android"))]
            crate::mcp::commands::cancel_mcp_oauth,
            #[cfg(not(target_os = "android"))]
            crate::mcp::commands::revoke_mcp_oauth,
            #[cfg(not(target_os = "android"))]
            crate::mcp::commands::get_mcp_oauth_status,
            #[cfg(not(target_os = "android"))]
            crate::mcp::commands::get_mcp_oauth_access_token,
            crate::commands::test_all_search_engines

            // =============== Notes (isolated) ===============
            ,crate::commands::notes_list,
            crate::commands::notes_list_meta,
            crate::commands::notes_create,
            crate::commands::notes_update,
            crate::commands::notes_set_favorite,
            crate::commands::notes_delete,
            crate::commands::notes_get,
            crate::commands::notes_save_asset
            ,crate::commands::notes_list_assets
            ,crate::commands::notes_delete_asset
            ,crate::commands::notes_resolve_asset_path
            ,crate::commands::notes_restore
            ,crate::commands::notes_assets_index_scan
            ,crate::commands::notes_assets_scan_orphans
            ,crate::commands::notes_assets_bulk_delete
            ,crate::commands::notes_list_advanced
            ,crate::commands::notes_get_subject_rag_config
            ,crate::commands::notes_update_subject_rag_config
            ,crate::commands::notes_set_pref
            ,crate::commands::notes_get_pref
            ,crate::commands::notes_export
            ,crate::commands::notes_export_single
            ,crate::commands::notes_import
            ,crate::commands::notes_import_markdown
            ,crate::commands::notes_import_markdown_batch
            ,crate::commands::notes_db_stats
            ,crate::commands::notes_db_vacuum
            ,crate::commands::notes_list_tags
            ,crate::commands::notes_search
            ,crate::commands::notes_mentions_search
            ,crate::commands::rag_rebuild_fts_index
            ,crate::commands::notes_rag_rebuild_fts_index
            ,crate::commands::notes_hard_delete
            ,crate::commands::notes_empty_trash
            ,crate::commands::notes_list_deleted
            // 笔记链接图（backlinks / outgoing / rebuild / unlinked mentions）
            ,crate::commands::notes_get_backlinks
            ,crate::commands::notes_get_outgoing_links
            ,crate::commands::notes_rebuild_links
            ,crate::commands::notes_unlinked_mentions
            // Canvas AI 工具命令（智能笔记）
            ,crate::commands::canvas_note_read
            ,crate::commands::canvas_note_append
            ,crate::commands::canvas_note_replace
            ,crate::commands::canvas_note_set
            // DataSpace (A/B) commands
            ,crate::data_space::get_data_space_info
            ,crate::data_space::mark_data_space_pending_switch_to_inactive
            ,crate::data_space::purge_all_database_files
            ,crate::data_space::purge_active_data_dir_now
            // Test Slot (C/D) commands - 用于前端全自动备份测试
            ,crate::data_space::get_test_slot_info
            ,crate::data_space::clear_test_slots
            ,crate::data_space::get_slot_directory
            ,crate::data_space::restart_app
            // Backup Test Commands - 前端全自动备份流程测试
            // Package Manager commands
            ,crate::commands::check_package_manager
            ,crate::commands::auto_install_package_manager
            ,crate::commands::check_all_package_managers
            // Test database management commands
            ,crate::commands::switch_to_test_database
            ,crate::commands::reset_test_database
            ,crate::commands::switch_to_production_database
            ,crate::commands::get_database_info
            ,crate::commands::seed_test_database
            ,crate::commands::check_test_dependencies
            ,crate::commands::set_test_run_id
            ,crate::commands::write_test_report
            // P0-27: WebView 设置备份/恢复命令
            ,crate::commands::save_webview_settings
            ,crate::commands::load_webview_settings
            // =================================================
            // Chat V2 - 新版聊天后端命令
            // =================================================
            ,crate::chat_v2::handlers::send_message::chat_v2_send_message
            ,crate::chat_v2::handlers::send_message::chat_v2_cancel_stream
            ,crate::chat_v2::handlers::send_message::chat_v2_retry_message
            ,crate::chat_v2::handlers::send_message::chat_v2_edit_and_resend
            ,crate::chat_v2::handlers::send_message::chat_v2_continue_message
            ,crate::chat_v2::kill_switch::chat_v2_emergency_stop
            ,crate::chat_v2::kill_switch::chat_v2_resume_agents
            ,crate::chat_v2::kill_switch::chat_v2_resume_automations
            ,crate::chat_v2::kill_switch::chat_v2_kill_switch_status
            ,crate::chat_v2::handlers::load_session::chat_v2_load_session
            // 消息分页加载（移动端渐进式历史补页）
            ,crate::chat_v2::handlers::load_messages_page::chat_v2_load_messages_page
            ,crate::chat_v2::handlers::manage_session::chat_v2_create_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_get_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_update_session_settings
            ,crate::chat_v2::handlers::manage_session::chat_v2_archive_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_save_session
            ,crate::chat_v2::handlers::block_actions::chat_v2_delete_message
            ,crate::chat_v2::handlers::block_actions::chat_v2_copy_block_content
            ,crate::chat_v2::handlers::block_actions::chat_v2_compact_session
            ,crate::chat_v2::handlers::block_actions::chat_v2_undo_compaction
            ,crate::chat_v2::handlers::block_actions::chat_v2_update_block_content
            ,crate::chat_v2::handlers::block_actions::chat_v2_update_block_tool_output
            ,crate::chat_v2::handlers::block_actions::chat_v2_get_anki_cards_from_block_by_document_id
            ,crate::chat_v2::handlers::block_actions::chat_v2_upsert_streaming_block
            ,crate::chat_v2::handlers::block_actions::chat_v2_anki_cards_result
            ,crate::chat_v2::handlers::manage_session::chat_v2_list_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_list_agent_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_count_sessions
            ,crate::chat_v2::handlers::manage_session::chat_v2_session_message_count
            // 全局消息统计摘要（统计面板真实数据源）
            ,crate::chat_v2::handlers::manage_session::chat_v2_get_message_summary
            ,crate::chat_v2::handlers::manage_session::chat_v2_delete_session
            // P1-3: 清空回收站（一次性删除所有已删除会话）
            ,crate::chat_v2::handlers::manage_session::chat_v2_empty_deleted_sessions
            // P1-23: 会话软删除与恢复
            ,crate::chat_v2::handlers::manage_session::chat_v2_soft_delete_session
            ,crate::chat_v2::handlers::manage_session::chat_v2_restore_session
            // 会话分支
            ,crate::chat_v2::handlers::manage_session::chat_v2_branch_session
            // 会话分组命令
            ,crate::chat_v2::handlers::group_handlers::chat_v2_create_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_update_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_archive_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_restore_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_delete_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_get_group
            ,crate::chat_v2::handlers::group_handlers::chat_v2_list_groups
            ,crate::chat_v2::handlers::group_handlers::chat_v2_reorder_groups
            ,crate::chat_v2::handlers::group_handlers::chat_v2_move_session_to_group
            ,crate::chat_v2::handlers::ocr::chat_v2_perform_ocr
            // 变体管理命令
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_switch_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_delete_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_retry_variant
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_retry_variants
            ,crate::chat_v2::handlers::variant_handlers::chat_v2_cancel_variant
            // 工具审批命令（敏感工具用户确认）
            ,crate::chat_v2::handlers::approval_handlers::chat_v2_tool_approval_respond
            ,crate::chat_v2::handlers::approval_handlers::chat_v2_tool_approval_cancel
            ,crate::chat_v2::handlers::approval_handlers::chat_v2_clear_approval_history
            // Ask / Plan / Craft 会话档位
            ,crate::chat_v2::handlers::manage_session::chat_v2_set_authority_mode
            ,crate::chat_v2::handlers::manage_session::chat_v2_set_permission_preset
            ,crate::chat_v2::handlers::manage_session::chat_v2_plan_gate_respond
            ,crate::chat_v2::runtime_roots::chat_v2_list_runtime_roots
            ,crate::chat_v2::runtime_roots::chat_v2_list_runtime_directory
            ,crate::chat_v2::runtime_roots::chat_v2_set_workspace_root
            ,crate::chat_v2::runtime_roots::chat_v2_reset_workspace_root
            ,crate::chat_v2::runtime_roots::chat_v2_authorize_runtime_root
            ,crate::chat_v2::runtime_roots::chat_v2_revoke_runtime_root
            ,crate::chat_v2::runtime_roots::chat_v2_set_skill_trust
            ,crate::chat_v2::runtime_roots::chat_v2_resolve_runtime_path
            ,crate::chat_v2::runtime_roots::chat_v2_delete_artifact
            ,crate::chat_v2::runtime_roots::chat_v2_revert_artifact_write
            ,crate::chat_v2::runtime_roots::chat_v2_revert_workspace_change
            ,crate::chat_v2::runtime_roots::chat_v2_read_runtime_file
            ,crate::chat_v2::tools::attachment_stage_executor::chat_v2_stage_context_attachments
            // 🆕 用户提问命令（轻量级问答交互）
            ,crate::chat_v2::handlers::ask_user_handlers::chat_v2_ask_user_respond
            // Canvas 工具前端回调命令（完全前端模式）
            ,crate::chat_v2::handlers::canvas_handlers::chat_v2_canvas_edit_result
            ,crate::chat_v2::handlers::canvas_handlers::chat_v2_canvas_edit_ack
            // 数据迁移命令（旧版 chat_messages 迁移到 Chat V2）
            ,crate::chat_v2::handlers::migration::chat_v2_check_migration_status
            ,crate::chat_v2::handlers::migration::chat_v2_migrate_legacy_chat
            ,crate::chat_v2::handlers::migration::chat_v2_rollback_migration
            // 内容搜索 + 标签管理命令
            ,crate::chat_v2::handlers::search_handlers::chat_v2_search_content
            // 会话元信息搜索（标题/描述/标签 LIKE）
            ,crate::chat_v2::handlers::search_handlers::chat_v2_search_sessions
            // 会话导出（markdown / json）
            ,crate::chat_v2::handlers::export_handlers::chat_v2_export_session
            // 事件发射失败计数（只读诊断）
            ,crate::chat_v2::events::chat_v2_get_emit_failure_count
            ,crate::chat_v2::handlers::search_handlers::rebuild_chat_fts
            ,crate::chat_v2::handlers::search_handlers::chat_v2_get_session_tags
            ,crate::chat_v2::handlers::search_handlers::chat_v2_get_tags_batch
            ,crate::chat_v2::handlers::search_handlers::chat_v2_add_tag
            ,crate::chat_v2::handlers::search_handlers::chat_v2_remove_tag
            ,crate::chat_v2::handlers::search_handlers::chat_v2_list_all_tags
            // 工作区命令（Agent 协作系统）
            ,crate::chat_v2::handlers::workspace_handlers::workspace_create
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get
            ,crate::chat_v2::handlers::workspace_handlers::workspace_close
            ,crate::chat_v2::handlers::workspace_handlers::workspace_delete
            ,crate::chat_v2::handlers::workspace_handlers::workspace_create_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_agents
            ,crate::chat_v2::handlers::workspace_handlers::workspace_send_message
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_messages
            ,crate::chat_v2::handlers::workspace_handlers::workspace_set_context
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get_context
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_documents
            ,crate::chat_v2::handlers::workspace_handlers::workspace_get_document
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_all
            ,crate::chat_v2::handlers::workspace_handlers::workspace_run_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_list_agent_profiles
            ,crate::chat_v2::handlers::workspace_handlers::workspace_cancel_agent
            ,crate::chat_v2::handlers::workspace_handlers::workspace_manual_wake
            ,crate::chat_v2::handlers::workspace_handlers::workspace_cancel_sleep
            ,crate::chat_v2::handlers::workspace_handlers::workspace_restore_executions
            // COMPAT-REMOVED 2026-07-20 (owner: platform-chat, remove target: vNext)
            // 旧 resource_* 命令已注销：前端零 invoke，替代路径 = vfs_* / VfsResourceRepo。
            // chat_v2::resource_repo 仍保留只读兼容层（见该模块头注释），勿再注册 resource_*。
            // 🆕 Skills 文件系统命令
            ,crate::chat_v2::skills::skill_list_directories
            ,crate::chat_v2::skills::skill_list_package_files
            ,crate::chat_v2::skills::skill_read_file
            ,crate::chat_v2::skills::skill_create
            ,crate::chat_v2::skills::skill_update
            ,crate::chat_v2::skills::skill_delete
            ,crate::chat_v2::skills::skill_import_zip
            ,crate::chat_v2::skill_updates::skill_check_updates
            ,crate::chat_v2::skill_updates::skill_update_from_source
            ,crate::chat_v2::skill_requires::skill_probe_requires
            ,crate::chat_v2::skill_taps::skill_tap_catalog
            ,crate::chat_v2::skill_taps::skill_tap_install
            ,crate::chat_v2::skill_taps::skill_export_tap
            ,crate::chat_v2::clawhub_client::clawhub_search
            ,crate::chat_v2::clawhub_client::clawhub_skill_detail
            ,crate::chat_v2::clawhub_client::clawhub_verify
            ,crate::chat_v2::clawhub_client::clawhub_download_and_scan
            // =================================================
            // VFS 虚拟文件系统命令
            // =================================================
            // 🆕 资源操作（已启用 - 替代独立 resources.db）
            ,crate::vfs::handlers::vfs_create_or_reuse
            ,crate::vfs::handlers::vfs_get_resource
            ,crate::vfs::handlers::vfs_resource_exists
            ,crate::vfs::handlers::vfs_increment_ref
            ,crate::vfs::handlers::vfs_decrement_ref
            // 笔记操作
            ,crate::vfs::handlers::vfs_create_note
            ,crate::vfs::handlers::vfs_update_note
            ,crate::vfs::handlers::vfs_get_note
            ,crate::vfs::handlers::vfs_get_note_content
            ,crate::vfs::handlers::vfs_list_notes
            ,crate::vfs::handlers::vfs_delete_note
            // 列表操作（供 Learning Hub 调用）
            ,crate::vfs::handlers::vfs_list_textbooks
            ,crate::vfs::handlers::vfs_list_exam_sheets
            ,crate::vfs::handlers::vfs_list_translations
            ,crate::vfs::handlers::vfs_list_essays
            ,crate::vfs::handlers::vfs_search_all
            // 路径缓存操作（文档 24 Prompt 3）
            ,crate::vfs::handlers::vfs_get_resource_path
            ,crate::vfs::handlers::vfs_update_path_cache
            // 引用模式命令（Prompt 2）
            ,crate::vfs::ref_handlers::vfs_get_resource_refs
            ,crate::vfs::ref_handlers::vfs_resolve_resource_refs
            ,crate::vfs::ref_handlers::vfs_get_resource_ref_count
            // 附件操作命令
            ,crate::vfs::handlers::vfs_upload_attachment
            ,crate::vfs::handlers::vfs_get_attachment_content
            ,crate::vfs::handlers::vfs_get_attachment
            ,crate::vfs::handlers::vfs_delete_attachment
            ,crate::vfs::handlers::vfs_get_attachment_config
            ,crate::vfs::handlers::vfs_set_attachment_root_folder
            ,crate::vfs::handlers::vfs_create_attachment_root_folder
            ,crate::vfs::handlers::vfs_get_or_create_attachment_root_folder
            // 统一文件操作命令（files 表）
            ,crate::vfs::handlers::vfs_upload_file
            ,crate::vfs::handlers::vfs_download_paper
            ,crate::vfs::handlers::vfs_get_file
            ,crate::vfs::handlers::vfs_list_files
            ,crate::vfs::handlers::vfs_delete_file
            ,crate::vfs::handlers::vfs_get_file_content
            // Blob 操作命令（整卷识别多模态改造 - 2025-12-09）
            ,crate::vfs::handlers::vfs_get_blob_base64
            // PDF 页面图片获取（支持 RAG 引用渲染 - 2026-01）
            ,crate::vfs::handlers::vfs_get_pdf_page_image
            // PDF 预处理流水线命令（2026-02）
            ,crate::vfs::handlers::vfs_get_pdf_processing_status
            ,crate::vfs::handlers::vfs_cancel_pdf_processing
            ,crate::vfs::handlers::vfs_retry_pdf_processing
            ,crate::vfs::handlers::vfs_start_pdf_processing
            ,crate::vfs::handlers::vfs_get_batch_pdf_processing_status
            ,crate::vfs::handlers::vfs_list_pending_pdf_processing
            // 媒体缓存管理命令
            ,crate::vfs::handlers::vfs_get_media_cache_stats
            ,crate::vfs::handlers::vfs_clear_media_cache
            // 整卷图片迁移命令（文档25）
            // VFS 统一知识管理命令
            ,crate::vfs::handlers::vfs_search
            ,crate::vfs::handlers::vfs_reindex_resource
            ,crate::vfs::handlers::vfs_get_index_status
            ,crate::vfs::handlers::vfs_toggle_index_disabled
            ,crate::vfs::handlers::vfs_get_embedding_stats
            ,crate::vfs::handlers::vfs_list_dimensions
            ,crate::vfs::handlers::vfs_assign_dimension_model
            ,crate::vfs::handlers::vfs_create_dimension
            ,crate::vfs::handlers::vfs_delete_dimension
            ,crate::vfs::handlers::vfs_get_preset_dimensions
            ,crate::vfs::handlers::vfs_get_dimension_range
            ,crate::vfs::handlers::vfs_set_default_embedding_dimension
            ,crate::vfs::handlers::vfs_get_default_embedding_dimension
            ,crate::vfs::handlers::vfs_clear_default_embedding_dimension
            ,crate::vfs::handlers::vfs_get_pending_resources
            ,crate::vfs::handlers::vfs_batch_index_pending
            ,crate::vfs::handlers::vfs_set_indexing_config
            ,crate::vfs::handlers::vfs_get_indexing_config
            ,crate::vfs::handlers::vfs_get_all_index_status
            // VFS 统一索引 Unit 级命令（2026-06-12 补注册：前端 vfsUnifiedIndexApi/unifiedIndexStore 已在调用）
            ,crate::vfs::index_handlers::vfs_unified_index_status
            ,crate::vfs::index_handlers::vfs_get_resource_units
            ,crate::vfs::index_handlers::vfs_reindex_unit
            ,crate::vfs::index_handlers::vfs_unified_batch_index
            ,crate::vfs::index_handlers::vfs_sync_resource_units
            ,crate::vfs::index_handlers::vfs_delete_resource_index
            ,crate::vfs::index_handlers::vfs_list_embedding_dims
            // VFS 数据透视命令（OCR 查看/清除、文本块查看）
            ,crate::vfs::handlers::vfs_get_resource_ocr_info
            ,crate::vfs::handlers::vfs_clear_resource_ocr
            ,crate::vfs::handlers::vfs_get_resource_text_chunks
            // VFS RAG 向量检索命令
            ,crate::vfs::handlers::vfs_rag_search
            ,crate::vfs::handlers::vfs_get_lance_stats
            ,crate::vfs::handlers::vfs_optimize_lance
            // VFS 多模态统一管理命令（2026-01）
            ,crate::vfs::handlers::vfs_multimodal_index
            ,crate::vfs::handlers::vfs_multimodal_search
            ,crate::vfs::handlers::vfs_multimodal_search_detailed
            ,crate::vfs::handlers::vfs_inspect_retrieval_capabilities
            ,crate::vfs::handlers::vfs_multimodal_stats
            ,crate::vfs::handlers::vfs_multimodal_delete
            ,crate::vfs::handlers::vfs_multimodal_index_resource
            // 知识导图操作
            ,crate::vfs::handlers::vfs_create_mindmap
            ,crate::vfs::handlers::vfs_get_mindmap
            ,crate::vfs::handlers::vfs_get_mindmap_content
            ,crate::vfs::handlers::vfs_get_mindmap_versions
            ,crate::vfs::handlers::vfs_get_mindmap_version_content
            ,crate::vfs::handlers::vfs_get_mindmap_version
            ,crate::vfs::handlers::vfs_restore_mindmap_version
            ,crate::vfs::handlers::vfs_update_mindmap
            ,crate::vfs::handlers::vfs_delete_mindmap
            ,crate::vfs::handlers::vfs_list_mindmaps
            ,crate::vfs::handlers::vfs_set_mindmap_favorite
            // 待办列表操作（独立于 VFS）
            ,crate::vfs::todo_handlers::todo_create_list
            ,crate::vfs::todo_handlers::todo_get_list
            ,crate::vfs::todo_handlers::todo_list_lists
            ,crate::vfs::todo_handlers::todo_update_list
            ,crate::vfs::todo_handlers::todo_delete_list
            ,crate::vfs::todo_handlers::todo_toggle_list_favorite
            ,crate::vfs::todo_handlers::todo_ensure_inbox
            ,crate::vfs::todo_handlers::todo_create_item
            ,crate::vfs::todo_handlers::todo_get_item
            ,crate::vfs::todo_handlers::todo_list_items
            ,crate::vfs::todo_handlers::todo_update_item
            ,crate::vfs::todo_handlers::todo_toggle_item
            ,crate::vfs::todo_handlers::todo_delete_item
            ,crate::vfs::todo_handlers::todo_reorder_items
            ,crate::vfs::todo_handlers::todo_list_today
            ,crate::vfs::todo_handlers::todo_list_overdue
            ,crate::vfs::todo_handlers::todo_list_upcoming
            ,crate::vfs::todo_handlers::todo_list_reminders
            ,crate::vfs::todo_handlers::todo_list_all_pending
            ,crate::vfs::todo_handlers::todo_list_completed
            ,crate::vfs::todo_handlers::todo_search
            ,crate::vfs::todo_handlers::todo_get_active_summary
            ,crate::vfs::todo_handlers::todo_counts_snapshot
            ,crate::vfs::todo_handlers::todo_ai_breakdown
            // 待办回收站命令
            ,crate::vfs::todo_handlers::todo_list_deleted_lists
            ,crate::vfs::todo_handlers::todo_restore_list
            ,crate::vfs::todo_handlers::todo_purge_list
            ,crate::vfs::todo_handlers::todo_purge_deleted_lists
            ,crate::vfs::todo_handlers::todo_restore_item
            ,crate::vfs::todo_handlers::todo_list_deleted_items
            ,crate::vfs::todo_handlers::todo_purge_item
            ,crate::vfs::todo_handlers::todo_purge_deleted_items
            // 清单重排 / 跨清单移动
            ,crate::vfs::todo_handlers::todo_reorder_lists
            ,crate::vfs::todo_handlers::todo_move_item
            // 番茄钟命令
            ,crate::vfs::todo_handlers::pomodoro_create_record
            ,crate::vfs::todo_handlers::pomodoro_get_record
            ,crate::vfs::todo_handlers::pomodoro_list_by_todo
            ,crate::vfs::todo_handlers::pomodoro_today_stats
            ,crate::vfs::todo_handlers::pomodoro_list_today
            ,crate::vfs::todo_handlers::pomodoro_daily_stats
            ,crate::vfs::pomodoro_handlers::pomodoro_delete_record
            ,crate::vfs::pomodoro_handlers::pomodoro_list_range
            ,crate::vfs::pomodoro_handlers::pomodoro_streak
            ,crate::vfs::pomodoro_handlers::pomodoro_hourly_stats
            ,crate::vfs::pomodoro_handlers::pomodoro_stats_by_todo
            ,crate::vfs::pomodoro_handlers::pomodoro_stats_overview
            ,crate::vfs::pomodoro_handlers::pomodoro_todo_focus_summary
            // 待办批量操作 / 回收站增强 / 统计聚合命令（2026-07-20）
            ,crate::vfs::todo_handlers::todo_batch_complete
            ,crate::vfs::todo_handlers::todo_batch_reschedule
            ,crate::vfs::todo_handlers::todo_batch_move
            ,crate::vfs::todo_handlers::todo_batch_delete
            ,crate::vfs::todo_handlers::todo_batch_restore
            ,crate::vfs::todo_handlers::todo_batch_purge
            ,crate::vfs::todo_handlers::todo_trash_counts
            ,crate::vfs::todo_handlers::todo_stats_overview
            ,crate::vfs::todo_handlers::todo_list_items_with_stats
            // 遗留补齐轮 r3（2026-07-20）：批量优先级 / 全量标签词表
            ,crate::vfs::todo_handlers::todo_batch_set_priority
            ,crate::vfs::todo_handlers::todo_list_all_tags
            // 索引诊断命令
            ,crate::vfs::handlers::vfs_debug_index_status
            ,crate::vfs::handlers::vfs_reset_disabled_to_pending
            ,crate::vfs::handlers::vfs_reset_indexed_without_embeddings
            ,crate::vfs::handlers::vfs_reset_all_index_state
            ,crate::vfs::handlers::vfs_diagnose_lance_schema
            // =================================================
            // LLM Usage 统计命令
            // =================================================
            ,crate::llm_usage::handlers::llm_usage_get_trends
            ,crate::llm_usage::handlers::llm_usage_by_model
            ,crate::llm_usage::handlers::llm_usage_by_caller
            ,crate::llm_usage::handlers::llm_usage_summary
            ,crate::llm_usage::handlers::llm_usage_session_summary
            ,crate::llm_usage::handlers::llm_usage_recent
            ,crate::llm_usage::handlers::llm_usage_daily
            ,crate::llm_usage::handlers::llm_usage_cleanup
            // =================================================
            // DSTU 访达协议层命令
            // =================================================
            ,crate::dstu::handlers::dstu_list
            ,crate::dstu::handlers::dstu_get
            ,crate::dstu::handlers::dstu_create
            ,crate::dstu::handlers::dstu_update
            ,crate::dstu::handlers::dstu_delete
            ,crate::dstu::handlers::dstu_restore
            ,crate::dstu::handlers::dstu_purge
            ,crate::dstu::handlers::dstu_set_favorite
            ,crate::dstu::handlers::dstu_list_deleted
            ,crate::dstu::handlers::dstu_purge_all
            ,crate::dstu::handlers::dstu_move
            ,crate::dstu::handlers::dstu_rename
            ,crate::dstu::handlers::dstu_copy
            ,crate::dstu::handlers::dstu_search
            ,crate::dstu::handlers::dstu_get_content
            ,crate::dstu::handlers::dstu_set_metadata
            ,crate::dstu::handlers::dstu_watch
            ,crate::dstu::handlers::dstu_unwatch
            // 批量操作命令
            ,crate::dstu::handlers::dstu_delete_many
            ,crate::dstu::handlers::dstu_restore_many
            ,crate::dstu::handlers::dstu_move_many
            // 文件夹内搜索
            ,crate::dstu::handlers::dstu_search_in_folder
            // 整卷识别多模态内容获取（文档 25 实现）
            ,crate::dstu::handlers::dstu_get_exam_content
            // =================================================
            // 契约 E: 真实路径架构命令（文档 28 Prompt 5）
            // =================================================
            // E1: 路径解析
            ,crate::dstu::handlers::dstu_parse_path
            ,crate::dstu::handlers::dstu_build_path
            // E2: 资源定位
            ,crate::dstu::handlers::dstu_get_resource_location
            ,crate::dstu::handlers::dstu_get_resource_by_path
            // E3: 移动操作
            ,crate::dstu::handlers::dstu_move_to_folder
            ,crate::dstu::handlers::dstu_batch_move
            // E4: 路径缓存
            ,crate::dstu::handlers::dstu_refresh_path_cache
            ,crate::dstu::handlers::dstu_get_path_by_id
            // =================================================
            // DSTU 统一资源导出命令
            // =================================================
            ,crate::dstu::export::dstu_export_formats
            ,crate::dstu::export::dstu_export
            // E5: Subject 迁移命令
            // =================================================
            // DSTU 文件夹命令（文档 23 Prompt 3）
            // =================================================
            // D1: 文件夹管理
            ,crate::dstu::folder_handlers::dstu_folder_create
            ,crate::dstu::folder_handlers::dstu_folder_get
            ,crate::dstu::folder_handlers::dstu_folder_rename
            ,crate::dstu::folder_handlers::dstu_folder_delete
            ,crate::dstu::folder_handlers::dstu_folder_move
            ,crate::dstu::folder_handlers::dstu_folder_set_expanded
            // D2: 内容管理
            ,crate::dstu::folder_handlers::dstu_folder_add_item
            ,crate::dstu::folder_handlers::dstu_folder_remove_item
            ,crate::dstu::folder_handlers::dstu_folder_move_item
            // D3: 查询
            ,crate::dstu::folder_handlers::dstu_folder_list
            ,crate::dstu::folder_handlers::dstu_folder_get_tree
            ,crate::dstu::folder_handlers::dstu_folder_get_items
            // D4: 上下文注入专用（文档 23 Prompt 4）
            ,crate::dstu::folder_handlers::dstu_folder_get_all_resources
            // D5: 排序
            ,crate::dstu::folder_handlers::dstu_folder_reorder
            ,crate::dstu::folder_handlers::dstu_folder_reorder_items
            // D6: 面包屑导航
            ,crate::dstu::folder_handlers::dstu_folder_get_breadcrumbs
            // =================================================
            // DSTU 回收站命令
            // =================================================
            ,crate::dstu::trash_handlers::dstu_soft_delete
            ,crate::dstu::trash_handlers::dstu_trash_restore
            ,crate::dstu::trash_handlers::dstu_list_trash
            ,crate::dstu::trash_handlers::dstu_empty_trash
            ,crate::dstu::trash_handlers::dstu_permanently_delete
            // =================================================
            // 教材库命令
            // =================================================
            ,crate::cmd::textbooks::textbooks_add
            ,crate::cmd::textbooks::textbooks_update_bookmarks
            ,crate::cmd::textbooks::textbooks_relink
            ,crate::cmd::textbooks::vfs_get_file_blob_path
            // =================================================
            // 智能题目集命令（Question Bank V2）
            // =================================================
            ,crate::commands::qbank_list_questions
            ,crate::commands::qbank_search_questions      // FTS5 全文搜索
            ,crate::commands::qbank_rebuild_fts_index     // FTS5 索引重建
            ,crate::commands::qbank_get_question
            ,crate::commands::qbank_get_question_by_card_id
            ,crate::commands::qbank_create_question
            ,crate::commands::qbank_batch_create_questions
            ,crate::commands::qbank_update_question
            ,crate::commands::qbank_batch_update_questions
            ,crate::commands::qbank_delete_question
            ,crate::commands::qbank_batch_delete_questions
            ,crate::commands::qbank_submit_answer
            ,crate::commands::qbank_toggle_favorite
            ,crate::commands::qbank_get_stats
            ,crate::commands::qbank_refresh_stats
            ,crate::commands::qbank_get_history
            ,crate::commands::qbank_get_submissions
            ,crate::commands::qbank_reset_progress
            ,crate::commands::qbank_reset_questions_progress
            // =================================================
            // 时间维度统计命令（2026-01 新增）
            // =================================================
            ,crate::commands::qbank_get_learning_trend
            ,crate::commands::qbank_get_activity_heatmap
            ,crate::commands::qbank_get_knowledge_stats
            ,crate::commands::qbank_get_knowledge_stats_with_comparison
            // =================================================
            // 练习模式扩展命令（2026-01 新增）
            // =================================================
            ,crate::commands::qbank_start_timed_practice
            ,crate::commands::qbank_generate_mock_exam
            ,crate::commands::qbank_submit_mock_exam
            ,crate::commands::qbank_get_daily_practice
            ,crate::commands::qbank_generate_paper
            ,crate::commands::qbank_get_check_in_calendar
            // =================================================
            // 学习热力图命令
            // =================================================
            ,crate::commands::get_learning_heatmap
            // =================================================
            // Memory-as-VFS 记忆系统命令
            // =================================================
            ,crate::memory::handlers::memory_get_config
            ,crate::memory::handlers::memory_set_root_folder
            ,crate::memory::handlers::memory_set_privacy_mode
            ,crate::memory::handlers::memory_create_root_folder
            ,crate::memory::handlers::memory_get_or_create_root_folder
            ,crate::memory::handlers::memory_search
            ,crate::memory::handlers::memory_read
            ,crate::memory::handlers::memory_write
            ,crate::memory::handlers::memory_list
            ,crate::memory::handlers::memory_get_tree
            // ★ 新增命令（2026-01 修复）
            ,crate::memory::handlers::memory_update_by_id
            ,crate::memory::handlers::memory_delete
            ,crate::memory::handlers::memory_move_to_folder
            ,crate::memory::handlers::memory_batch_delete
            ,crate::memory::handlers::memory_batch_move
            ,crate::memory::handlers::memory_update_tags
            ,crate::memory::handlers::memory_restore_stale
            ,crate::memory::handlers::memory_restore_archived
            ,crate::memory::handlers::memory_get_tags
            ,crate::memory::handlers::memory_add_relation
            ,crate::memory::handlers::memory_remove_relation
            ,crate::memory::handlers::memory_get_related
            ,crate::memory::handlers::memory_to_anki_document
            ,crate::memory::handlers::memory_write_smart
            ,crate::memory::handlers::memory_write_batch
            ,crate::memory::handlers::memory_set_auto_create_subfolders
            ,crate::memory::handlers::memory_set_default_category
            ,crate::memory::handlers::memory_set_auto_extract_frequency
            ,crate::memory::handlers::memory_export_all
            ,crate::memory::handlers::memory_get_profile
            ,crate::memory::handlers::memory_get_audit_logs
            // =================================================
            // 复习计划与间隔重复系统（SM-2 算法）
            // =================================================
            ,crate::review_plan_service::review_plan_create
            ,crate::review_plan_service::review_plan_process
            ,crate::review_plan_service::review_plan_get_due
            ,crate::review_plan_service::review_plan_get_due_with_filter
            ,crate::review_plan_service::review_plan_get_stats
            ,crate::review_plan_service::review_plan_refresh_stats
            ,crate::review_plan_service::review_plan_get_by_question
            ,crate::review_plan_service::review_plan_get
            ,crate::review_plan_service::review_plan_suspend
            ,crate::review_plan_service::review_plan_resume
            ,crate::review_plan_service::review_plan_delete
            ,crate::review_plan_service::review_plan_get_history
            ,crate::review_plan_service::review_plan_batch_create
            ,crate::review_plan_service::review_plan_create_for_exam
            ,crate::review_plan_service::review_plan_list_by_exam
            ,crate::review_plan_service::review_plan_get_or_create
            ,crate::review_plan_service::review_plan_get_calendar_data
            // =================================================
            // FSRS 闪卡复习（M2：近似调度，独立于 anki_cards / review_plans）
            // =================================================
            ,crate::cmd::fsrs_review::fsrs_enqueue_cards
            ,crate::cmd::fsrs_review::fsrs_get_due
            ,crate::cmd::fsrs_review::fsrs_preview_intervals
            ,crate::cmd::fsrs_review::fsrs_rate
            ,crate::cmd::fsrs_review::fsrs_get_stats
            ,crate::cmd::fsrs_review::fsrs_undo_last_review
            ,crate::cmd::fsrs_review::fsrs_suspend_card
            ,crate::cmd::fsrs_review::fsrs_unsuspend_card
            ,crate::cmd::fsrs_review::fsrs_get_review_statistics
            ,crate::cmd::fsrs_review::fsrs_get_scheduler_config
            ,crate::cmd::fsrs_review::fsrs_update_scheduler_config
            ,crate::cmd::fsrs_review::fsrs_reset_card_progress
            // =================================================
            // APKG 本地导入
            // =================================================
            ,crate::cmd::apkg_import::import_apkg_to_library
            // =================================================
            // Workbench 内置浏览器（B1e；content 窗零 capability，见 capabilities/browser-content.json）
            // =================================================
            ,crate::cmd::browser::browser_open_session
            ,crate::cmd::browser::browser_navigate
            ,crate::cmd::browser::browser_back
            ,crate::cmd::browser::browser_forward
            ,crate::cmd::browser::browser_reload
            ,crate::cmd::browser::browser_get_state
            ,crate::cmd::browser::browser_get_surface_host_mode
            ,crate::cmd::browser::browser_set_surface_bounds
            ,crate::cmd::browser::browser_set_surface_visibility
            ,crate::cmd::browser::browser_content_user_input
            ,crate::cmd::browser::browser_close
            ,crate::cmd::browser::browser_focus
            ,crate::cmd::browser::browser_release_surface_focus
            ,crate::cmd::browser::browser_take_over
            ,crate::cmd::browser::browser_snapshot
            ,crate::cmd::browser::browser_click
            ,crate::cmd::browser::browser_type
            ,crate::cmd::browser::browser_set_input_files
            ,crate::cmd::browser::browser_list_downloads
            ,crate::cmd::browser::browser_list_task_downloads
            ,crate::cmd::browser::browser_scroll
            // COMPAT-REMOVED 2026-07-20 (owner: learning-qbank, remove target: vNext)
            // 题库专属 qbank_*_sync_* 冲突命令已注销：QuestionSyncService::detect_conflicts /
            // save_conflict 无生产调用方，question_sync_conflicts 表无真实生产者。
            // 真冲突源 = data_governance __sync_conflicts（RecordConflictsPanel）。
            // 保留 QuestionSyncService::mark_as_modified / content_hash 与历史 DB 列迁移。
            // =================================================
            // 数据治理系统命令（2026-01-30）
            // 注意：data_governance 已在 default features 中启用
            // =================================================
            ,crate::data_governance::commands::data_governance_get_maintenance_status
            ,crate::data_governance::commands::data_governance_get_schema_registry
            ,crate::data_governance::commands::data_governance_get_migration_status
            ,crate::data_governance::commands::data_governance_get_database_status
            ,crate::data_governance::commands::data_governance_run_health_check
            ,crate::data_governance::commands::data_governance_get_audit_logs
            ,crate::data_governance::commands::data_governance_cleanup_audit_logs
            // 备份命令
            ,crate::data_governance::commands_backup::data_governance_run_backup
            ,crate::data_governance::commands_backup::data_governance_cancel_backup
            ,crate::data_governance::commands_backup::data_governance_get_backup_job
            ,crate::data_governance::commands_backup::data_governance_list_backup_jobs
            ,crate::data_governance::commands_backup::data_governance_get_backup_list
            ,crate::data_governance::commands_backup::data_governance_delete_backup
            ,crate::data_governance::commands_backup::data_governance_check_disk_space_for_restore
            ,crate::data_governance::commands_backup::data_governance_verify_backup
            ,crate::data_governance::commands_backup::data_governance_auto_verify_latest_backup
            ,crate::data_governance::commands_backup::data_governance_backup_tiered
            // ZIP 导出/导入命令
            ,crate::data_governance::commands_zip::data_governance_backup_and_export_zip
            ,crate::data_governance::commands_zip::data_governance_export_zip
            ,crate::data_governance::commands_zip::data_governance_import_zip
            // 恢复命令
            ,crate::data_governance::commands_restore::data_governance_restore_backup
            // 同步命令
            ,crate::data_governance::commands_sync::data_governance_save_cloud_config_ssot
            ,crate::data_governance::commands_sync::data_governance_get_cloud_config_ssot
            ,crate::data_governance::commands_sync::data_governance_clear_cloud_config_ssot
            ,crate::data_governance::commands_sync::data_governance_get_sync_status
            ,crate::data_governance::commands_sync::data_governance_detect_conflicts
            ,crate::data_governance::commands_sync::data_governance_resolve_conflicts
            ,crate::data_governance::commands_sync::data_governance_run_sync
            ,crate::data_governance::commands_sync::data_governance_run_sync_with_progress
            ,crate::data_governance::commands_sync::data_governance_export_sync_data
            ,crate::data_governance::commands_sync::data_governance_import_sync_data
            // 同步检疫管理
            ,crate::data_governance::commands_sync::data_governance_list_quarantine
            ,crate::data_governance::commands_sync::data_governance_retry_quarantine
            ,crate::data_governance::commands_sync::data_governance_discard_quarantine
            ,crate::data_governance::commands_sync::data_governance_retry_all_quarantine
            ,crate::data_governance::commands_sync::data_governance_discard_all_quarantine
            // Tombstone 删除传播
            ,crate::data_governance::commands_sync::data_governance_mark_blob_deleted
            ,crate::data_governance::commands_sync::data_governance_mark_asset_deleted
            // 记录级冲突
            ,crate::data_governance::commands_sync::data_governance_list_record_conflicts
            ,crate::data_governance::commands_sync::data_governance_count_record_conflicts
            ,crate::data_governance::commands_sync::data_governance_resolve_record_conflict
            ,crate::data_governance::commands_sync::data_governance_purge_resolved_conflicts
            // Prune 断层检测
            ,crate::data_governance::commands_sync::data_governance_detect_prune_gap
            // 任务恢复命令（断点续传支持）
            ,crate::data_governance::commands_backup::data_governance_resume_backup_job
            ,crate::data_governance::commands_backup::data_governance_list_resumable_jobs
            ,crate::data_governance::commands_backup::data_governance_cleanup_persisted_jobs
            // 清空数据命令
            ,crate::data_governance::commands_backup::data_governance_purge_all_data
            // 资产管理命令
            ,crate::data_governance::commands_asset::data_governance_scan_assets
            ,crate::data_governance::commands_asset::data_governance_get_asset_types
            ,crate::data_governance::commands_asset::data_governance_restore_with_assets
            ,crate::data_governance::commands_asset::data_governance_verify_backup_with_assets
            ,crate::data_governance::commands::data_governance_get_migration_diagnostic_report
            ,crate::data_governance::commands::data_governance_run_slot_c_empty_db_test
            ,crate::data_governance::commands::data_governance_run_slot_d_clone_db_test
            // =================================================
            // Chat V2 自动化：立即运行（headless agent turn）
            // =================================================
            ,crate::chat_v2::automations::chat_v2_automation_list
            ,crate::chat_v2::automations::chat_v2_automation_create
            ,crate::chat_v2::automations::chat_v2_automation_set_enabled
            ,crate::chat_v2::automations::chat_v2_automation_update
            ,crate::chat_v2::automations::chat_v2_automation_delete
            ,crate::chat_v2::automations::chat_v2_automation_run_now
            ,crate::chat_v2::automations::chat_v2_automation_runs
            ,crate::chat_v2::automations::chat_v2_automation_retry_run
            ,crate::chat_v2::automations::chat_v2_automation_cancel_run
            ,crate::chat_v2::automations::chat_v2_automation_summary
            ,crate::chat_v2::automations::chat_v2_automation_set_background_enabled
        ])
        // 注册 pdfstream:// 自定义协议，用于 PDF 流式加载（支持 HTTP Range Request）
        .register_uri_scheme_protocol("pdfstream", |ctx, request| {
            let allowed_dirs = crate::pdf_protocol::resolve_allowed_dirs(ctx.app_handle());
            match crate::pdf_protocol::handle_asset_protocol(&request, &allowed_dirs) {
                Ok(response) => response,
                Err(e) => {
                    error!("pdfstream:// 协议处理失败: {}", e);
                    let cors_origin = crate::pdf_protocol::cors_origin_for_request(&request);
                    tauri::http::Response::builder()
                        .status(500)
                        .header("Access-Control-Allow-Origin", cors_origin.clone())
                        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                        .header("Access-Control-Allow-Headers", "Range")
                        .header("Vary", "Origin")
                        .body(b"Internal Server Error".to_vec())
                        .unwrap_or_else(|_| {
                            tauri::http::Response::builder()
                                .status(500)
                                .header("Access-Control-Allow-Origin", cors_origin)
                                .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                                .header("Access-Control-Allow-Headers", "Range")
                                .header("Vary", "Origin")
                                .body(b"Internal Server Error".to_vec())
                                .unwrap_or_else(|_| {
                                    tauri::http::Response::new(b"Internal Server Error".to_vec())
                                })
                        })
                }
            }
        })
        // 注册 filestream:// 自定义协议，用于媒体（音频/视频/图片）与通用 blob 流式加载
        .register_uri_scheme_protocol("filestream", |ctx, request| {
            let allowed_dirs = crate::pdf_protocol::resolve_allowed_dirs(ctx.app_handle());
            let blob_dirs = crate::file_stream_protocol::resolve_blob_dirs(ctx.app_handle());
            match crate::file_stream_protocol::handle_asset_protocol(
                &request,
                &allowed_dirs,
                &blob_dirs,
            ) {
                Ok(response) => response,
                Err(e) => {
                    error!("filestream:// 协议处理失败: {}", e);
                    let cors_origin =
                        crate::file_stream_protocol::cors_origin_for_request(&request);
                    tauri::http::Response::builder()
                        .status(500)
                        .header("Access-Control-Allow-Origin", cors_origin.clone())
                        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                        .header("Access-Control-Allow-Headers", "Range")
                        .header("Vary", "Origin")
                        .body(b"Internal Server Error".to_vec())
                        .unwrap_or_else(|_| {
                            tauri::http::Response::new(b"Internal Server Error".to_vec())
                        })
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                crate::chat_v2::automations::mark_automation_app_exiting();
                tauri::async_runtime::block_on(async {
                    crate::debug_logger::flush_global_logger().await;
                    crate::debug_log_service::flush_pending_debug_log_writes().await;
                    crate::background_tasks::shutdown().await;
                    crate::debug_logger::flush_global_logger().await;
                    crate::debug_log_service::flush_pending_debug_log_writes().await;
                });
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                #[allow(unused_unsafe)]
                unsafe {
                    use cocoa::appkit::{NSApp, NSApplication};
                    use cocoa::base::YES;

                    let ns_app = NSApp();
                    ns_app.activateIgnoringOtherApps_(YES);
                }
            }
            _ => {}
        });
}

/// Starts the durable VFS index consumer. SQLite owns pending/failed state and
/// the Lance orphan queue, so an interrupted run resumes on the next tick or
/// application start without relying on an in-memory job list.
fn start_vfs_index_worker(
    vfs_db: Arc<crate::vfs::VfsDatabase>,
    llm_manager: Arc<crate::llm_manager::LLMManager>,
    lance_store: Arc<crate::vfs::VfsLanceStore>,
) {
    crate::background_tasks::spawn(async move {
        let mut last_run: Option<std::time::Instant> = None;
        loop {
            if crate::background_tasks::BACKGROUND_TASKS.is_closed() {
                break;
            }

            let basic = crate::vfs::VfsIndexingService::new(vfs_db.clone());
            let config = match basic.get_indexing_config() {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!("[VfsIndexWorker] Failed to load config: {}", error);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            let interval = std::time::Duration::from_secs(config.interval_secs.max(1) as u64);
            let due = last_run.is_none_or(|last| last.elapsed() >= interval);
            if !config.enabled || !due {
                let remaining = last_run
                    .map(|last| interval.saturating_sub(last.elapsed()))
                    .unwrap_or(interval)
                    .min(std::time::Duration::from_secs(5));
                tokio::time::sleep(remaining.max(std::time::Duration::from_millis(100))).await;
                continue;
            }
            last_run = Some(std::time::Instant::now());

            let full = match crate::vfs::VfsFullIndexingService::new(
                vfs_db.clone(),
                llm_manager.clone(),
                lance_store.clone(),
            ) {
                Ok(service) => service,
                Err(error) => {
                    tracing::warn!(
                        "[VfsIndexWorker] Failed to initialize text worker: {}",
                        error
                    );
                    continue;
                }
            };

            // Keep jobs pending while a capability is unconfigured. Configuration
            // changes are picked up by a later tick without exhausting retry_count.
            let text_embedding_configured = llm_manager.get_embedding_model_config().await.is_ok();
            if text_embedding_configured {
                match full.process_pending_batch(config.batch_size).await {
                    Ok((success, failed)) if success > 0 || failed > 0 => tracing::info!(
                        "[VfsIndexWorker] text batch completed: success={}, failed={}",
                        success,
                        failed
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("[VfsIndexWorker] text batch failed: {}", error)
                    }
                }
            } else if let Err(error) = full.drain_lance_orphan_queue(200).await {
                // Deletion compensation itself does not require an embedding provider.
                tracing::warn!("[VfsIndexWorker] Orphan cleanup failed: {}", error);
            }

            if llm_manager.is_multimodal_rag_configured().await {
                let multimodal = crate::vfs::VfsMultimodalService::new(
                    vfs_db.clone(),
                    llm_manager.clone(),
                    lance_store.clone(),
                );
                match multimodal.process_pending_batch(config.batch_size).await {
                    Ok((success, failed)) if success > 0 || failed > 0 => tracing::info!(
                        "[VfsIndexWorker] multimodal batch completed: success={}, failed={}",
                        success,
                        failed
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("[VfsIndexWorker] multimodal batch failed: {}", error)
                    }
                }
            }

            // Throttled Lance maintenance (compact + prune + index-delta merge).
            // The interval check lives inside maybe_optimize_all, so calling it on
            // every tick is cheap; failures must never affect the indexing loop.
            match lance_store.maybe_optimize_all().await {
                Ok(optimized) if optimized > 0 => tracing::info!(
                    "[VfsIndexWorker] Lance auto-optimize completed: {} tables",
                    optimized
                ),
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("[VfsIndexWorker] Lance auto-optimize failed: {}", error)
                }
            }
        }
        tracing::info!("[VfsIndexWorker] stopped");
    });
}

// Helper to build the global application state
fn build_app_state(
    app_data_dir: std::path::PathBuf,
    app_handle: tauri::AppHandle,
) -> crate::commands::AppState {
    // === Core helpers ===
    let file_manager = Arc::new(
        crate::file_manager::FileManager::new(app_data_dir.clone())
            .expect("Failed to initialise FileManager"),
    );

    let db_path = file_manager.get_database_path();
    let database =
        Arc::new(crate::database::Database::new(&db_path).expect("Failed to initialise Database"));

    let database_manager = Arc::new(
        crate::database::DatabaseManager::new(&db_path)
            .expect("Failed to initialise DatabaseManager"),
    );

    // Notes/Anki: use primary database managed by data governance
    let notes_database = database.clone();
    let anki_database = database.clone();

    // ★ VFS 统一存储：核心服务依赖，初始化失败时 fail-fast，避免半初始化状态
    let vfs_db = Arc::new(
        crate::vfs::VfsDatabase::new(&app_data_dir)
            .unwrap_or_else(|e| panic!("Failed to initialise VFS Database: {}", e)),
    );
    app_handle.manage(vfs_db.clone());

    // ★ VfsLanceStore：非核心，可降级
    let vfs_lance_store = match crate::vfs::VfsLanceStore::new(vfs_db.clone()) {
        Ok(store) => {
            let store = std::sync::Arc::new(store);
            app_handle.manage(store.clone());
            Some(store)
        }
        Err(e) => {
            log::error!("[AppState] VfsLanceStore init failed, degrading: {}", e);
            None
        }
    };

    let llm_manager = Arc::new(
        crate::llm_manager::LLMManager::new(database.clone(), file_manager.clone())
            .expect("Failed to initialise LLMManager"),
    );
    app_handle.manage(llm_manager.clone());
    if let Some(lance_store) = vfs_lance_store {
        start_vfs_index_worker(vfs_db.clone(), llm_manager.clone(), lance_store);
    }
    let exam_sheet_service = Arc::new(
        crate::exam_sheet_service::ExamSheetService::new(
            database.clone(),
            file_manager.clone(),
            vfs_db.clone(),
        )
        .expect("Failed to initialise ExamSheetService"),
    );
    let pdf_ocr_service = Arc::new(crate::pdf_ocr_service::PdfOcrService::new(
        file_manager.clone(),
        llm_manager.clone(),
    ));

    // ★ F7：.master_key 损坏/不可读时给出可操作的诊断，而非裸 expect。
    // 注意：此处**不**自动重置密钥——若密钥只是被临时占用/瞬时读失败而非真损坏，
    // 静默重置会永久销毁既有加密数据（云凭据等）的可解密性。宁可明确失败、引导用户
    // 从备份恢复或显式重置，也不冒数据不可逆丢失的风险。
    let crypto_service = Arc::new(
        crate::crypto::CryptoService::new(&app_data_dir).unwrap_or_else(|e| {
            log::error!(
                "[AppState] CryptoService 初始化失败：{e}。\
                 通常是主密钥文件(.master_key)损坏或不可读。请从备份恢复该文件；\
                 若确认要放弃既有加密数据，可手动删除 app_data 下的 .master_key 后重启（云凭据等需重新录入）。"
            );
            panic!("Failed to initialise CryptoService: {e}");
        }),
    );

    let temp_sessions = Arc::new(Mutex::new(HashMap::new()));
    let pdf_ocr_cancellations = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::watch::Sender<bool>,
    >::new()));
    let pdf_ocr_pauses = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::watch::Sender<bool>,
    >::new()));
    let pdf_ocr_skip_pages = Arc::new(Mutex::new(HashMap::<
        String,
        std::collections::HashSet<usize>,
    >::new()));
    let csv_import_cancellations = Arc::new(dashmap::DashMap::new());
    let question_import_cancellations = Arc::new(dashmap::DashMap::new());

    let notes_manager = Arc::new(
        crate::notes_manager::NotesManager::new_with_vfs(notes_database.clone(), vfs_db.clone())
            .expect("Failed to init NotesManager"),
    );

    // ★ backup_job_manager 已移至 Tauri State（BackupJobManagerState）单例模式

    // essay_grading_db 已移除，作文批改现在使用 VFS 统一存储

    // 初始化自定义批阅模式管理器（JSON 存储）
    let custom_mode_manager = crate::essay_grading::custom_modes::CustomModeManager::new(
        &file_manager.get_writable_app_data_dir(),
    );

    let question_bank_service = Some(Arc::new(
        crate::question_bank_service::QuestionBankService::new(vfs_db.clone()),
    ));

    // ★ PDF 预处理流水线服务（2026-02）
    let pdf_processing_service = Some(Arc::new(crate::vfs::PdfProcessingService::new(
        vfs_db.clone(),
        database.clone(),
        llm_manager.clone(),
        file_manager.clone(),
    )));
    // 注册 PdfProcessingService 到 Tauri 状态（供 vfs_get_pdf_processing_status 等命令使用）
    if let Some(ref pps) = pdf_processing_service {
        app_handle.manage(pps.clone());

        match pps.recover_stuck_tasks() {
            Ok(recovered) if !recovered.is_empty() => {
                tracing::info!(
                    "[AppSetup] Recovered {} stuck media processing tasks, scheduling auto-resume",
                    recovered.len()
                );
                // ★ G1 修复：恢复出的 pending 任务自动续跑（带并发上限），
                // 否则被重启打断的 OCR/压缩/向量索引永久停摆且无 UI 入口恢复。
                let pps_resume = pps.clone();
                tauri::async_runtime::spawn(async move {
                    pps_resume.resume_recovered_tasks(recovered).await;
                });
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("[AppSetup] Failed to recover stuck tasks: {}", e);
            }
        }
    }

    // ★ 启动时恢复卡在 indexing 状态的索引记录（vfs_index_units + resources）
    match crate::vfs::VfsFullIndexingService::recover_stuck_indexing(&vfs_db) {
        Ok(count) if count > 0 => {
            tracing::info!("[AppSetup] Recovered {} stuck indexing records", count);
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("[AppSetup] Failed to recover stuck indexing records: {}", e);
        }
    }

    // ★ 2026-06-10（审阅问题 A2）：启动时清扫 ref_count=0 的 blob。
    // 引用计数递减在事务内只改计数不删文件（两阶段删除），
    // 若上次会话在"提交后、清扫前"崩溃，残留的 0 引用 blob 在此回收。
    {
        let vfs_db_sweep = vfs_db.clone();
        tauri::async_runtime::spawn_blocking(move || {
            match crate::vfs::repos::VfsBlobRepo::cleanup_unreferenced(&vfs_db_sweep) {
                Ok(count) if count > 0 => {
                    tracing::info!("[AppSetup] Swept {} unreferenced blobs", count);
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("[AppSetup] Unreferenced blob sweep failed: {}", e);
                }
            }

            // ★ 2026-06-12（审阅问题 S2）：清扫长期无引用的检索资源行。
            // 引用计数本身对称（消息保存 +1 / 消息·会话删除 -1），但归零后的
            // retrieval 行没有任何删除路径，会在 resources 表无限累积。
            // 24h 宽限期防止误删"已创建、消息尚未保存"窗口中的资源。
            const RETRIEVAL_SWEEP_GRACE_MS: i64 = 24 * 60 * 60 * 1000;
            match vfs_db_sweep.get_conn_safe() {
                Ok(conn) => {
                    match crate::vfs::repos::VfsResourceRepo::cleanup_unreferenced_retrievals(
                        &conn,
                        RETRIEVAL_SWEEP_GRACE_MS,
                    ) {
                        Ok(count) if count > 0 => {
                            tracing::info!(
                                "[AppSetup] Swept {} unreferenced retrieval resources",
                                count
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!("[AppSetup] Retrieval resource sweep failed: {}", e);
                        }
                    }

                    // ★ 2026-06-12（审阅问题 S5）：回收历史泄漏的孤儿笔记/导图资源。
                    // 旧代码在笔记内容编辑、导图 purge 时遗留无人引用的资源行。
                    match crate::vfs::repos::VfsResourceRepo::cleanup_orphan_note_mindmap_resources(
                        &conn,
                        RETRIEVAL_SWEEP_GRACE_MS,
                    ) {
                        Ok(count) if count > 0 => {
                            tracing::info!(
                                "[AppSetup] Swept {} orphan note/mindmap resources",
                                count
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!("[AppSetup] Orphan note/mindmap sweep failed: {}", e);
                        }
                    }

                    // ★ 2026-06-12（第二轮审阅）：回收孤儿索引单元。
                    // essay/translation/textbook/exam 的旧 purge 路径不清理
                    // vfs_index_units，残留的 units/segments/Lance 向量会让
                    // 语义检索命中已删除内容。Lance 行先入列孤儿队列再删。
                    match crate::vfs::repos::index_unit_repo::sweep_orphan_index_units(&conn) {
                        Ok(count) if count > 0 => {
                            tracing::info!(
                                "[AppSetup] Swept {} orphan index units (lance rows enqueued)",
                                count
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!("[AppSetup] Orphan index unit sweep failed: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[AppSetup] Retrieval sweep skipped (no connection): {}", e);
                }
            }

            // ★ 2026-07-20：一次性回填笔记链接图（修复 DSTU 时期写路径不维护
            // note_links 的存量缺口）。带 KV 标志（vfs_indexing_config），
            // 成功后不再执行；失败不写标志，下次启动自动重试。
            match crate::vfs::repos::VfsNoteRepo::backfill_note_links_once(&vfs_db_sweep, 500) {
                Ok(true) => {
                    tracing::info!("[AppSetup] One-time note links backfill completed");
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(
                        "[AppSetup] Note links backfill failed (will retry next launch): {}",
                        e
                    );
                }
            }
        });
    }

    // 🔧 Phase 1: 启动时恢复卡住的 Anki 制卡任务。
    // 保留时间阈值，避免多实例/后台任务场景下把刚更新过的任务误标为 Failed。
    match anki_database.recover_stuck_document_tasks() {
        Ok(count) if count > 0 => {
            tracing::info!("[AppSetup] Recovered {} stuck Anki document tasks", count);
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("[AppSetup] Failed to recover stuck Anki tasks: {}", e);
        }
    }

    // 设置 AppHandle 到 PdfProcessingService（供事件推送使用）
    if let Some(ref pps) = pdf_processing_service {
        let pdf_service_for_handle = pps.clone();
        let app_handle_clone = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            pdf_service_for_handle
                .set_app_handle(app_handle_clone)
                .await;
        });
    }

    crate::commands::AppState {
        database,
        database_manager,
        anki_database,
        notes_database,

        vfs_db: Some(vfs_db),
        custom_mode_manager: Some(custom_mode_manager),
        notes_manager,
        file_manager,
        exam_sheet_service,
        pdf_ocr_service,
        pdf_processing_service,
        temp_sessions,
        llm_manager,
        crypto_service,
        pdf_ocr_cancellations,
        pdf_ocr_pauses,
        pdf_ocr_sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())), // 🎯 Initialize sessions map
        pdf_ocr_skip_pages,
        csv_import_cancellations,
        question_import_cancellations,
        app_handle,
        active_database: RwLock::new(crate::commands::ActiveDatabaseKind::Production),
        question_bank_service,
    }
}

/// 初始化 MCP 客户端
#[cfg(feature = "mcp")]
async fn init_mcp_client(
    database: Arc<crate::database::Database>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 从数据库读取 MCP 配置
    let mcp_config = load_mcp_config_from_db(&database).await?;

    // 移除全局启用开关：初始化不再受限于 mcp.enabled

    debug!("🔧 [MCP] Initializing MCP client with config: transport={:?}, performance={{ timeout_ms: {}, rate_limit: {}, cache_max_size: {}, cache_ttl_ms: {} }}",
        mcp_config.transport,
        mcp_config.performance.timeout_ms,
        mcp_config.performance.rate_limit_per_second,
        mcp_config.performance.cache_max_size,
        mcp_config.performance.cache_ttl_ms
    );

    // 使用全局初始化函数
    match crate::mcp::initialize_global_mcp_client(mcp_config).await {
        Ok(()) => {
            info!("🔧 [MCP] Global MCP client initialized successfully");
            // 注册 tools/list_changed 事件以清空工具缓存
            if let Some(client) = crate::mcp::get_global_mcp_client().await {
                let app_handle_for_event = app_handle.clone();
                client.on_event(move |event| {
                    if let crate::mcp::McpEvent::ToolsChanged = event {
                        log::info!("🔧 [MCP] tools/list_changed received → clearing LLMManager MCP tool cache");
                        if let Some(handle) = &app_handle_for_event {
                            let _ = handle.emit("mcp_tools_changed", &serde_json::json!({"ts": chrono::Utc::now().to_rfc3339()}));
                        }
                    }
                }).await;
            }
            Ok(())
        }
        Err(e) => {
            error!("🔧 [MCP] Failed to initialize MCP client: {}", e);
            // 不要因为 MCP 初始化失败而阻止应用启动
            Ok(())
        }
    }
}

/// 从数据库加载 MCP 配置
#[cfg(feature = "mcp")]
pub async fn load_mcp_config_from_db(
    database: &Arc<crate::database::Database>,
) -> Result<crate::mcp::McpConfig, Box<dyn std::error::Error + Send + Sync>> {
    let mut config = crate::mcp::McpConfig::default();

    // 读取多工具配置列表
    if let Ok(Some(tools_json)) = database.get_setting("mcp.tools.list") {
        // 解析工具列表JSON
        if let Ok(tools_list) = serde_json::from_str::<Vec<serde_json::Value>>(&tools_json) {
            // 如果有工具列表，使用第一个工具作为主要连接（兼容现有单一客户端架构）
            if let Some(first_tool) = tools_list.first() {
                if let Some(transport_type) =
                    first_tool.get("transportType").and_then(|v| v.as_str())
                {
                    match transport_type {
                        "stdio" => {
                            let command = first_tool
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or("mcp-server")
                                .to_string();

                            let args: Vec<String> = match first_tool.get("args") {
                                Some(serde_json::Value::Array(items)) => items
                                    .iter()
                                    .filter_map(|value| {
                                        value.as_str().map(|s| s.trim().to_string())
                                    })
                                    .filter(|s| !s.is_empty())
                                    .collect(),
                                Some(serde_json::Value::String(s)) => s
                                    .split(',')
                                    .map(|segment| segment.trim().to_string())
                                    .filter(|segment| !segment.is_empty())
                                    .collect(),
                                _ => Vec::new(),
                            };

                            // 解析环境变量
                            let mut env = std::collections::HashMap::new();
                            if let Some(env_obj) = first_tool.get("env").and_then(|v| v.as_object())
                            {
                                for (key, value) in env_obj {
                                    if let Some(value_str) = value.as_str() {
                                        env.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            let framing = match first_tool
                                .get("framing")
                                .or_else(|| first_tool.get("framingMode"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_lowercase())
                            {
                                Some(mode)
                                    if mode == "content_length" || mode == "content-length" =>
                                {
                                    crate::mcp::McpFraming::ContentLength
                                }
                                _ => crate::mcp::McpFraming::JsonLines,
                            };

                            let working_dir = first_tool
                                .get("cwd")
                                .or_else(|| first_tool.get("workingDir"))
                                .and_then(|v| v.as_str())
                                .map(std::path::PathBuf::from);

                            config.transport = crate::mcp::McpTransportConfig::Stdio {
                                command,
                                args,
                                port: None,
                                working_dir,
                                framing,
                                env,
                            };
                        }
                        "websocket" => {
                            let url = first_tool
                                .get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ws://localhost:8080")
                                .to_string();

                            // 解析环境变量
                            let mut env = std::collections::HashMap::new();
                            if let Some(env_obj) = first_tool.get("env").and_then(|v| v.as_object())
                            {
                                for (key, value) in env_obj {
                                    if let Some(value_str) = value.as_str() {
                                        env.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport =
                                crate::mcp::McpTransportConfig::WebSocket { url, env };
                        }
                        "sse" => {
                            // 尝试多个位置查找端点URL
                            let endpoint = first_tool
                                .get("endpoint")
                                .or_else(|| first_tool.get("url"))
                                .or_else(|| {
                                    // 查找mcpServers中的URL
                                    first_tool
                                        .get("mcpServers")
                                        .and_then(|servers| servers.as_object())
                                        .and_then(|servers| {
                                            servers
                                                .values()
                                                .next()
                                                .and_then(|server| server.get("url"))
                                        })
                                })
                                .or_else(|| {
                                    first_tool.get("fetch").and_then(|fetch| fetch.get("url"))
                                })
                                .and_then(|v| v.as_str())
                                .unwrap_or("http://localhost:8080/sse")
                                .to_string();

                            debug!("🔧 [MCP] Found SSE endpoint: {}", endpoint);

                            let api_key = first_tool
                                .get("apiKey")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            // 解析额外HTTP头
                            let mut headers = std::collections::HashMap::new();
                            if let Some(headers_obj) =
                                first_tool.get("headers").and_then(|v| v.as_object())
                            {
                                for (key, value) in headers_obj {
                                    if let Some(value_str) = value.as_str() {
                                        headers.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport = crate::mcp::McpTransportConfig::SSE {
                                endpoint,
                                api_key,
                                oauth: None,
                                headers,
                            };
                        }
                        "streamable_http" => {
                            // 尝试多个位置查找URL
                            let url = first_tool
                                .get("url")
                                .or_else(|| first_tool.get("endpoint"))
                                .or_else(|| {
                                    // 查找mcpServers中的URL
                                    first_tool
                                        .get("mcpServers")
                                        .and_then(|servers| servers.as_object())
                                        .and_then(|servers| {
                                            // 获取第一个服务器的URL
                                            servers
                                                .values()
                                                .next()
                                                .and_then(|server| server.get("url"))
                                        })
                                })
                                .or_else(|| {
                                    // 查找fetch配置中的URL
                                    first_tool.get("fetch").and_then(|fetch| fetch.get("url"))
                                })
                                .and_then(|v| v.as_str())
                                .unwrap_or("http://localhost:8080/mcp")
                                .to_string();

                            debug!("🔧 [MCP] Found streamable_http URL: {}", url);

                            let api_key = first_tool
                                .get("apiKey")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            // 解析额外HTTP头
                            let mut headers = std::collections::HashMap::new();
                            if let Some(headers_obj) =
                                first_tool.get("headers").and_then(|v| v.as_object())
                            {
                                for (key, value) in headers_obj {
                                    if let Some(value_str) = value.as_str() {
                                        headers.insert(key.clone(), value_str.to_string());
                                    }
                                }
                            }

                            config.transport = crate::mcp::McpTransportConfig::StreamableHttp {
                                url,
                                api_key,
                                oauth: None,
                                headers,
                            };
                        }
                        _ => {
                            warn!(
                                "🔧 [MCP] Unknown transport type in tool config: {}, using default",
                                transport_type
                            );
                        }
                    }
                }
            }
        }
    } else {
        // 如果没有新的工具列表，回退到旧的单一配置方式（向后兼容）
        if let Ok(Some(transport_type)) = database.get_setting("mcp.transport.type") {
            match transport_type.as_str() {
                "stdio" => {
                    let command = database
                        .get_setting("mcp.transport.command")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "mcp-server".to_string());

                    let args_str = database
                        .get_setting("mcp.transport.args")
                        .ok()
                        .flatten()
                        .unwrap_or_default();

                    let args: Vec<String> = if args_str.is_empty() {
                        vec![]
                    } else {
                        args_str.split(',').map(|s| s.trim().to_string()).collect()
                    };

                    let framing = database
                        .get_setting("mcp.transport.framing")
                        .ok()
                        .flatten()
                        .map(|s| match s.as_str() {
                            "content_length" => crate::mcp::McpFraming::ContentLength,
                            _ => crate::mcp::McpFraming::JsonLines,
                        })
                        .unwrap_or_default();

                    config.transport = crate::mcp::McpTransportConfig::Stdio {
                        command,
                        args,
                        port: None,
                        working_dir: None,
                        framing,
                        env: std::collections::HashMap::new(),
                    };
                }
                "websocket" => {
                    let url = database
                        .get_setting("mcp.transport.url")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "ws://localhost:8080".to_string());

                    config.transport = crate::mcp::McpTransportConfig::WebSocket {
                        url,
                        env: std::collections::HashMap::new(),
                    };
                }
                _ => {
                    warn!(
                        "🔧 [MCP] Unknown transport type: {}, using default",
                        transport_type
                    );
                }
            }
        }
    }

    // 读取工具配置
    if let Ok(Some(cache_ttl_str)) = database.get_setting("mcp.tools.cache_ttl_ms") {
        if let Ok(cache_ttl_ms) = cache_ttl_str.parse::<u64>() {
            config.tools.cache_ttl_ms = cache_ttl_ms;
        }
    }

    if let Ok(Some(advertise_all_str)) = database.get_setting("mcp.tools.advertise_all_tools") {
        config.tools.advertise_all_tools =
            advertise_all_str.to_lowercase() != "0" && advertise_all_str.to_lowercase() != "false";
    }

    if let Ok(Some(whitelist_str)) = database.get_setting("mcp.tools.whitelist") {
        if !whitelist_str.is_empty() {
            config.tools.whitelist = whitelist_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect();
        }
    }

    if let Ok(Some(blacklist_str)) = database.get_setting("mcp.tools.blacklist") {
        if !blacklist_str.is_empty() {
            config.tools.blacklist = blacklist_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect();
        }
    }

    // 读取性能配置
    if let Ok(Some(timeout_str)) = database.get_setting("mcp.performance.timeout_ms") {
        if let Ok(timeout_ms) = timeout_str.parse::<u64>() {
            config.performance.timeout_ms = timeout_ms;
        }
    }

    if let Ok(Some(rate_limit_str)) = database.get_setting("mcp.performance.rate_limit_per_second")
    {
        if let Ok(rate_limit) = rate_limit_str.parse::<usize>() {
            config.performance.rate_limit_per_second = rate_limit;
        }
    }
    // 新增：资源缓存大小
    if let Ok(Some(cache_max_size_str)) = database.get_setting("mcp.performance.cache_max_size") {
        if let Ok(cache_max_size) = cache_max_size_str.parse::<usize>() {
            config.performance.cache_max_size = cache_max_size;
        }
    }
    // 新增：资源缓存TTL
    if let Ok(Some(cache_ttl_ms_str)) = database.get_setting("mcp.performance.cache_ttl_ms") {
        if let Ok(cache_ttl_ms) = cache_ttl_ms_str.parse::<u64>() {
            config.performance.cache_ttl_ms = cache_ttl_ms;
        }
    }

    Ok(config)
}
