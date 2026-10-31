//! Deep Student 后端最底层 crate。
//!
//! 放所有模块共用、且不依赖 tauri 的定义：数据模型与错误类型（`models`、
//! `error_details`）、模型 API 配置（`llm_config`）、跨链路的提示词契约常量、
//! 外部工具名规范化等。上层 crate 只能依赖这里，这里不能依赖任何上层 crate。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致，app 通过
//! `pub use dstu_core::xxx` 保留原路径。

pub mod canonical_tools;
pub mod error_details;
pub mod error_recovery;
pub mod json_validator;
pub mod llm_config;
pub mod media_types;
pub mod models;
pub mod net_policy; // 内网/回环地址判定（SSRF 拦截正源，browser::policy 按原路径重导出）
pub mod prompt_contracts; // 跨链路共享的 LLM 输出契约常量（LaTeX 等，单一来源）
pub mod services;
pub mod workflow_error_handler;
