//! Chat V2 适配器模块
//!
//! ⚠️ **注意**: 以下三个适配器文件为历史参考实现，当前未被 Pipeline 使用。
//! Pipeline 使用的是 `pipeline.rs` 中的内联实现（包含更多功能字段）。
//! 保留仅供参考，不应在新代码中引用。
//!
//! ## 模块结构（全部为死代码）
//! - `llm_adapter`: LLM 流式回调适配器（Pipeline 使用内联版本）
//! - `vfs_rag_adapter`: VFS RAG 检索适配器（Pipeline 直接调用 VFS 模块）
//! - `tool_adapter`: 工具调用适配器（Pipeline 使用 ToolExecutorRegistry）

#[deprecated(note = "Dead code: Pipeline uses inline ChatV2LLMAdapter in pipeline.rs")]
pub mod llm_adapter;
#[deprecated(note = "Dead code: Pipeline uses inline tool execution")]
pub mod tool_adapter;
#[deprecated(note = "Dead code: Pipeline uses inline VFS RAG retrieval")]
pub mod vfs_rag_adapter;

// 重导出（标记 deprecated 以提醒调用者迁移）
#[allow(deprecated)]
pub use llm_adapter::ChatV2LLMAdapter;
#[allow(deprecated)]
pub use tool_adapter::{
    ChatV2ToolAdapter, ImageGenOptions, DEFAULT_TOOL_TIMEOUT_MS, DEFAULT_WEB_SEARCH_TIMEOUT_MS,
};
#[allow(deprecated)]
pub use vfs_rag_adapter::{ChatV2VfsRagAdapter, VfsRagServiceFactory};
