//! Chat V2 - 新版聊天后端模块（app 门面）
//!
//! step 10 L5：编排引擎（pipeline / 工具环 / 执行器框架 / 审批 / 工作区 / 技能 / 命令处理器 …）
//! 已迁到 dstu-agent 的 `chat_v2` 模块（文件保持原目录结构）。这里整体重导出，
//! 所有 `crate::chat_v2::…` 路径（含 `generate_handler!` 条目）保持不变。
//!
//! 仍在 app 声明的子模块（本地声明优先于 glob 重导出）：
//! - `tools`：门面 + 37 个域执行器（经 `agent_wiring::roster::AppExecutorRoster` 注入）
//! - `handlers`：门面 + `canvas_handlers`
//! - `skill_taps`：门面 + `skill_export_tap` 命令薄包装（需要 `AppState.file_manager`）

pub use dstu_agent::chat_v2::*;

pub mod handlers;
pub mod skill_taps;
pub mod tools;
