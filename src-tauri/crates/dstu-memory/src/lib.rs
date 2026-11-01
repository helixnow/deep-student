//! Deep Student 记忆能力 crate。
//!
//! - `memory`：Memory-as-VFS 记忆系统（复用 VFS 基础设施）——记忆服务、自动抽取 / 演化 /
//!   语义去重、压缩前记忆冲刷（chat_v2 流水线调用）、每日日志、审计日志、学习者画像
//!   （`learner_profile`，依赖 `MemoryService` / `MemoryConfig` / 记忆结构锁）以及记忆命令。
//! - 扩展点实现：`memory::delete_hook`（vfs 笔记删除回调）与 `memory::mastery_hook`
//!   （dstu-learning 的 `mastery::profile_sink`），仍由 app 的 `extensions::register_extensions()`
//!   按原路径注册。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过 `pub use dstu_memory::memory`
//! 保留原路径（`generate_handler!` 中的 `memory::handlers::*` 命令路径不变）。

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::models;
use dstu_learning::mastery;
use dstu_llm::llm_manager;
use dstu_platform::background_tasks;
use dstu_vfs::vfs;
// 仅 `memory::test_support` 夹具使用。
#[cfg(any(test, feature = "test-util"))]
use dstu_storage::{database, file_manager};

#[allow(dead_code)]
pub mod memory; // Memory-as-VFS 记忆系统（复用 VFS 基础设施）
