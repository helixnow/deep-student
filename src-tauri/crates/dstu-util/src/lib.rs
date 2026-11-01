//! Deep Student 通用工具 crate（不依赖 tauri）。
//!
//! 聊天查询/计时、token 预算、SSE 行缓冲与流式 UTF-8 解码、受限远程抓取、
//! 文本与 Unicode 处理等纯工具函数。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 的 `utils` 模块
//! 通过 `pub use dstu_util::utils::*` 保留 `crate::utils::xxx`，
//! `llm_manager::utf8_stream` 重导出 `dstu_util::utf8_stream`。

// 拆分前这些模块通过 `crate::models` 引用数据模型，保留原路径。
use dstu_core::models;

// 二维码 PNG（base64）；app 的 `plugins::ilink_bot::qr` 按原路径重导出，dstu-media 的 B 站扫码登录共用。
pub mod qr;
pub mod utf8_stream;
#[allow(dead_code)]
pub mod utils;
