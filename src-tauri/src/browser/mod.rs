//! Workbench 内置浏览器
//!
//! # 数据层（design §9）
//!
//! - 文件：`{active_dir}/browser.db`（与 `chat_v2.db` / `mistakes.db` 同级）
//! - Profile（cookie/缓存）：`{active_dir}/browser-profiles/default/` — **不进** SQLite
//! - 治理：**一期豁免** — 不进 `DatabaseId` / RowSync / 默认备份（对齐 `message_queue.db`；
//!   已在 `schema_registry.rs` 文档注释列出）
//! - 建库：**懒加载** — [`BrowserDatabase::ensure_open`] / [`ensure`]；flag 关不建库
//! - 迁移：`migrations/browser/`，模块内 Refinery embed，**不**挂 `MigrationCoordinator::run_all()`
//!
//! # 策略
//!
//! 顶层导航策略见 [`policy`]。
//!
//! # 运行时（B1c）
//!
//! - [`BrowserService`]：开/关 session、导航、焦点、状态
//! - Content 窗 label 固定 [`window::BROWSER_CONTENT_LABEL`]（`browser-content`）
//! - 事件：[`events::EVT_NAVIGATED`] / [`events::EVT_CLOSED`] / [`events::EVT_TITLE_CHANGED`]
//!
//! # 注入桥（B1d）
//!
//! - 脚本：[`bridge::INIT_SCRIPT`]（`include_str!("browser_bridge.js")`）
//! - 结果取回：[`bridge::eval_with_result`]（Win WebView2 / macOS WKWebView / Linux WebKitGTK）
//! - Service API：[`bridge::BridgeClient`]
//!
//! # 接线（B1e）
//!
//! ```ignore
//! // setup：不要无条件 ensure_open；manage 未打开的 DB + Service
//! let browser_db = Arc::new(browser::BrowserDatabase::from_data_space()?);
//! let browser_svc = browser::BrowserService::new(app.handle().clone(), browser_db);
//! browser::BrowserService::boot_cleanup(app.handle());
//! app.manage(browser_svc);
//!
//! // 首次 open_session 内才会 ensure_open + 建窗
//! // 桥：window::bridge_init_script() → bridge::INIT_SCRIPT
//! let bridge = browser::bridge::client(app.handle().clone());
//! let snap = bridge.snapshot(true).await?;
//! ```

pub mod bridge;
pub mod database;
pub mod error;
pub mod events;
pub mod policy;
pub mod repository;
pub mod service;
pub mod session;
pub mod types;
pub mod window;

pub use bridge::{
    client as bridge_client, eval_with_result, BridgeClient, BridgeError, BridgeResult,
    INIT_SCRIPT as BRIDGE_INIT_SCRIPT,
};
pub use database::{
    resolve_active_dir, BrowserDatabase, BrowserPool, BrowserPooledConnection,
    CURRENT_SCHEMA_VERSION, DATABASE_FILENAME,
};
pub use error::{BrowserError, BrowserResult};
pub use events::{
    BrowserClosedPayload, BrowserControlModeChangedPayload, BrowserNavigatedPayload,
    BrowserNavigationBlockedPayload, BrowserTitleChangedPayload, EVT_CLOSED,
    EVT_CONTROL_MODE_CHANGED, EVT_NAVIGATED, EVT_NAVIGATION_BLOCKED, EVT_TITLE_CHANGED,
};
pub use policy::{
    allow_navigation, allow_navigation_with_options, is_blocked_for_agent, is_internal_ip,
    is_loopback_host, NavigationDenyReason,
};
pub use repository::BrowserRepository;
pub use service::{
    assert_settings_gates_open, BrowserDownloadObservation, BrowserDownloadState, BrowserService,
    FLAG_UI_WORKBENCH_BROWSER, SETTING_BROWSER_ENABLED, SETTING_BROWSER_NETWORK_MODE,
    SETTING_WORKBENCH_MODE,
};
pub use session::{
    BrowserSession, BrowserSessionState, ControlMode, HistoryEntry, OpenSessionOptions, MAX_HISTORY,
};
pub use types::*;
pub use window::{
    boot_cleanup_orphan_windows, bridge_init_script, default_profile_dir,
    BRIDGE_INIT_SCRIPT_PLACEHOLDER, BROWSER_CONTENT_LABEL, DEFAULT_PROFILE_ID,
};

/// 供后续 Service / commands 接线的最小出口：确保 `browser.db` 已打开并完成迁移。
///
/// 幂等；未调用前磁盘上不应出现 `browser.db`（除非外部已创建）。
pub fn ensure(db: &BrowserDatabase) -> BrowserResult<()> {
    db.ensure_open()
}
