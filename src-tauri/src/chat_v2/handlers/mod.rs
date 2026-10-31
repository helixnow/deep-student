//! Chat V2 Tauri 命令处理器（app 门面）。
//!
//! step 10 L5：命令处理器已迁到 dstu-agent 的 `chat_v2::handlers`，这里整体重导出，
//! `generate_handler!` 里的 `crate::chat_v2::handlers::…` 路径保持不变。
//! `canvas_handlers` 依赖留在 app 的 `tools::canvas_executor`，因此仍在 app 声明。

pub use dstu_agent::chat_v2::handlers::*;

pub mod canvas_handlers;

pub use canvas_handlers::chat_v2_canvas_edit_result;
