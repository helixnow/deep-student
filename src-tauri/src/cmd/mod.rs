//! 命令子模块
//!
//! 从原 commands.rs 拆分而来，按功能域组织
//!
//! 清理说明（2026-01）：
//! - 移除废弃模块：mistakes, bridge, canvas_board

pub mod anki_cards;
pub mod anki_connect;
pub mod enhanced_anki;
pub mod helpers;
pub mod mcp;
// ★ pub mod multimodal_rag 已移除（2026-01 清理：VFS 多模态完全替代）
pub mod notes;
// ★ pub mod rag 已移除（2026-01 清理：VFS RAG 完全替代）
pub mod ocr;
pub mod textbooks;
pub mod translation;
pub mod web_search; // OCR 引擎配置命令

// Re-export AppState from the main commands module
pub use crate::commands::AppState;
