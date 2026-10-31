//! Deep Student Workbench 内置浏览器域 crate。
//!
//! `browser`：`BrowserService`（session / 导航 / 下载 / 双闸）、content WebView 创建与
//! surface 管理（`window`）、注入桥（`bridge` + `browser_bridge.js`）、`browser.db`
//! 惰性池与仓储（`database` / `repository`）、导航策略（`policy`，SSRF 判定正源在
//! `dstu_core::net_policy`，这里按原路径重导出）与事件；`cmd::browser`：21 个 `browser_*`
//! Tauri 命令。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过 `pub use dstu_browser::browser`
//! 与 `cmd` 模块里的 `pub use dstu_browser::cmd::browser` 保留原路径（`generate_handler!` 不变）。
//! Agent 会话下载的 artifact 根目录由 chat_v2 提供，经 `browser::hooks` 的 `Slot` 在 app 的
//! `extensions::register_extensions()` 接线。

// 与 app 相同的宏展开余量（注入桥 / 命令返回值的 json! 块）。
#![recursion_limit = "512"]

pub mod browser; // Workbench 内置浏览器（browser.db 懒加载 + 导航策略；见 design §9）

/// 命令子模块（与 app 的 `cmd` 同构，app 的 `cmd::browser` 重导出这里）。
pub mod cmd {
    pub mod browser;
}

// 拆分前这些模块通过 `crate::X` 引用已下沉到低层 crate 的模块，这里保留原路径，
// 使搬过来的文件里的 `crate::<module>` 不需要改写。
pub(crate) use dstu_core::task_objects;
pub(crate) use dstu_storage::{data_space, database, feature_flags};
