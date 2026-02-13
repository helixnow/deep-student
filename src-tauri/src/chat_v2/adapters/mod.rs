//! Chat V2 适配器模块
//!
//! 提供与外部服务（LLM、RAG、工具等）的适配器，
//! 将外部服务的回调转换为 Chat V2 的块级事件。
//!
//! ## 模块结构
//! - `llm_adapter`: LLM 流式回调适配器，实现 `LLMStreamHooks` trait
//! - `rag_adapter`: RAG/图谱/笔记检索适配器
//! - `vfs_rag_adapter`: VFS 统一知识管理 RAG 检索适配器
//! - `tool_adapter`: 工具调用适配器（MCP 工具、网络搜索、图片生成）

pub mod llm_adapter;
// ★ rag_adapter 模块已移除（2026-01 清理：VFS RAG 完全替代）
pub mod tool_adapter;
pub mod vfs_rag_adapter;

// 重导出常用类型
pub use llm_adapter::ChatV2LLMAdapter;
// ★ ChatV2RagAdapter 已移除（2026-01 清理：VFS RAG 完全替代）
pub use tool_adapter::{
    ChatV2ToolAdapter, ImageGenOptions, DEFAULT_TOOL_TIMEOUT_MS, DEFAULT_WEB_SEARCH_TIMEOUT_MS,
};
pub use vfs_rag_adapter::{ChatV2VfsRagAdapter, VfsRagServiceFactory};
// 注意：SourceInfo 从 types 模块导出，不在此重导出
