//! 命令子模块
//!
//! 从原 commands.rs 拆分而来，按功能域组织
//!
//! 清理说明（2026-01）：
//! - 移除废弃模块：mistakes, bridge, canvas_board

pub mod anki_cards;
pub mod anki_connect;
pub mod apkg_import;
pub mod browser;
pub mod enhanced_anki;
pub mod fsrs_review;
pub mod helpers;
pub mod mcp;
pub mod media;
pub mod network;
pub mod notes;
pub mod ocr;
pub mod openai_codex;
pub mod power;
pub mod textbooks;
pub mod translation;
pub mod web_search; // OCR 引擎配置命令
pub mod window_effects; // macOS 窗口毛玻璃

// Re-export AppState from the main commands module
pub use crate::commands::AppState;
