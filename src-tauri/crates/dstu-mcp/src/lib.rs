//! Deep Student MCP 与外部工具能力 crate。
//!
//! MCP（Model Context Protocol）客户端（`mcp`：stdio/SSE/Streamable HTTP/WebSocket
//! 传输、OAuth 授权、全局客户端、协议版本协商）与工具注册表 / web_search 外部搜索
//! （`tools`：`ToolRegistry`、`Tool`、`ToolContext`、MCP 桥接与 legacy 回退注入）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_mcp::xxx` 保留原路径。`cmd::mcp` / `cmd::web_search` 命令依赖
//! app 的 `AppState`，仍留在 app。

// 与 app 相同的宏展开余量（工具 schema / MCP 请求体的 json! 块）。
#![recursion_limit = "512"]

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{canonical_tools, error_details, models};
use dstu_llm::llm_manager;
use dstu_storage::database;

// 以下仅 `mcp` 模块使用（`mcp::auth` 另有非 Android 门控），按同样的 cfg 引入避免未使用告警。
#[cfg(feature = "mcp")]
use dstu_core::net_policy;
#[cfg(all(feature = "mcp", not(target_os = "android")))]
use dstu_security::secure_store;
#[cfg(feature = "mcp")]
use dstu_util::utils;

// 可选：MCP 客户端与 rmcp 校验（app 的 `mcp` feature 转发到这里）
#[cfg(feature = "mcp")]
pub mod mcp;
#[allow(dead_code)]
pub mod tools;
