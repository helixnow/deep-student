//! Deep Student 研究域 crate。
//!
//! - `insight`：Insight Recall v2 灵感库（采集 → 认领 → 纠正 → 墓碑；召回与披露阶梯；
//!   巩固任务队列 / SRS 投影）。设计规格见 docs/dev/insight-recall/README.md。
//!   巩固任务按拆分前原样直接以 SQL 写 mistakes 库的 `anki_cards` / `mastery_events`，
//!   后续再收敛到所属域。
//! - `hpias`：HPIAS 深度研究 pipeline（事件 emit、检索后端、LLM 综合）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过 `pub use dstu_research::hpias`
//! 与 `pub mod insight { pub use dstu_research::insight::*; ... }` 保留原路径。
//! `insight::handlers`（Tauri 命令，取 app 的 `AppState`）仍留在 app。

// 与 app 相同的宏展开余量（hpias 事件载荷的 json! 块）。
#![recursion_limit = "512"]

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::models;
use dstu_llm::llm_manager;
use dstu_storage::database;
use dstu_vfs::vfs;

// insight::tests 通过 `crate::data_governance::{migration, schema_registry}` 迁移 mistakes 库；
// app 中二者即 `dstu_storage` 的同名模块的重导出。
#[cfg(test)]
mod data_governance {
    pub(crate) use dstu_storage::{migration, schema_registry};
}

pub mod hpias; // HPIAS 深度研究事件 emit（Generative UI researchSessionId 桥接）
pub mod insight; // Insight Recall v2 灵感库（docs/dev/insight-recall/README.md）
