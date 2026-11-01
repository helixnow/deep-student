//! Deep Student LLM 服务层 crate。
//!
//! 多供应商模型管理与请求管线（`llm_manager`，含 `adapters` / `snapshots` /
//! `exam_engine` / `model2_pipeline`）、供应商协议适配（`providers`、
//! `adapters`）、内置供应商（`vendors`）、多模态嵌入（`multimodal`）、
//! OpenAI Codex 登录与用量（`openai_codex`）、OCR 适配器（`ocr_adapters`、
//! `deepseek_ocr_parser`、`ocr_circuit_breaker`）、推理策略（`reasoning_policy`）、
//! 配置自愈（`config_recovery`）与制卡模型分层路由（`anki_model_routing`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_llm::xxx` 保留原路径。
//!
//! `llm_usage` 已随 `dstu-storage` 下沉；`translation` / `voice_input` / `tools` /
//! `mcp` 仍留在 app，作为本 crate 的上层消费者。

// 大型 json! 审计块（provider 请求体 / 工具结果）需要更深的宏展开余量。
#![recursion_limit = "512"]

pub mod adapters;
pub mod anki_model_routing;
pub mod config_recovery;
pub mod deepseek_ocr_parser;
#[allow(dead_code)]
pub mod llm_manager;
#[allow(dead_code, deprecated)]
pub mod multimodal; // 多模态知识库模块（基于 Qwen3-VL-Embedding/Reranker）
pub mod ocr_adapters; // OCR 适配器模块（支持多种 OCR 引擎）
pub mod ocr_circuit_breaker; // OCR 熔断器（三态：Closed/Open/HalfOpen）
pub mod openai_codex;
pub mod providers;
pub mod reasoning_policy; // 思维链回传策略模块（文档 29 第 7 节）
pub mod vendors;

// 拆分前这些模块通过 `crate::X` 引用低层 crate 的模块，这里保留原路径，
// 使搬过来的文件里的 `crate::<module>` 不需要改写。
pub(crate) use dstu_core::{
    canonical_tools, json_validator, llm_config, models, prompt_contracts, text_escape,
    token_source,
};
pub(crate) use dstu_platform::{background_tasks, debug_log_service, debug_logger};
pub(crate) use dstu_security::crypto;
pub(crate) use dstu_storage::{database, file_manager, llm_usage};
pub(crate) use dstu_util::utils;
