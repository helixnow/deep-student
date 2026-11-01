//! Deep Student 后端最底层 crate。
//!
//! 放所有模块共用、且不依赖 tauri 的定义：数据模型与错误类型（`models`、
//! `error_details`）、模型 API 配置（`llm_config`）、跨链路的提示词契约常量、
//! 外部工具名规范化等。上层 crate 只能依赖这里，这里不能依赖任何上层 crate。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致，app 通过
//! `pub use dstu_core::xxx` 保留原路径。

/// app（根包 `deep-student`）的版本号。
///
/// 成员 crate 的 `CARGO_PKG_VERSION` 是 `0.0.0`；从 app 移出的代码需要版本号时
/// 统一读这里，值由 `build.rs` 从根 `Cargo.toml` 的 `[package] version` 注入。
pub const APP_VERSION: &str = env!("DSTU_APP_VERSION");

pub mod agent; // agent 消息/工具调用的纯数据类型（chat_v2::types、chat_v2::grants 按原路径重导出）
pub mod canonical_tools;
pub mod error_details;
pub mod error_recovery;
pub mod events; // Chat V2 事件名常量（chat_v2::events 按原路径重导出）
pub mod json_validator;
pub mod llm_config;
pub mod media_types;
pub mod models;
pub mod net_policy; // 内网/回环地址判定（SSRF 拦截正源，browser::policy 按原路径重导出）
pub mod prompt_contracts; // 跨链路共享的 LLM 输出契约常量（LaTeX 等，单一来源）
pub mod resource_types; // 内容块（ContentBlock）：chat_v2 资源格式化的共用形状
pub mod services;
pub mod spaced_repetition; // SM-2 间隔重复算法（纯函数，vfs 复习计划仓储也要用）
pub mod task_objects; // 任务对象句柄/批量清单/页读写（chat_v2::task_objects 按原路径重导出）
pub mod text_escape; // XML 文本转义（chat_v2::vfs_resolver 按原路径重导出）
pub mod token_source; // Token 统计来源（chat_v2::types 按原路径重导出）
pub mod tool_args; // 工具参数/错误载荷辅助（chat_v2::tools::arg_utils 按原路径重导出）
pub mod tool_names; // 工具名命名空间解析（chat_v2::tools::types 按原路径重导出）
pub mod workflow_error_handler;

#[cfg(test)]
mod tests {
    /// 防止 build.rs 失效时把 app 版本静默变成成员 crate 的 0.0.0。
    #[test]
    fn app_version_is_injected_from_app_manifest() {
        assert!(!super::APP_VERSION.is_empty());
        assert_ne!(super::APP_VERSION, "0.0.0");
    }
}
