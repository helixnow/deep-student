//! Deep Student 学习能力 crate。
//!
//! - `fsrs_scheduler`：Anki 语义的 FSRS 调度层（学习步 / fuzz / 逻辑日，纯函数）；
//! - `mastery`：掌握度中间层（append-only `mastery_events` + 聚合 `mastery_states`、
//!   FSRS 调度偏置、`mastery_get_overview` 命令）；画像薄弱点回流经
//!   `mastery::profile_sink` 扩展点，由 memory 在组合根注入实现；
//! - `study_loop`：学习闭环胶水层（媒体转写出处锚点、学习时长命令）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_learning::xxx` 保留原路径。`memory::learner_profile` 仍留在 app 的
//! memory（依赖 `MemoryService` / `MemoryConfig` / 记忆结构锁），见 `mastery::profile_sink`。

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::models;
use dstu_vfs::vfs;

pub mod fsrs_scheduler; // Anki 语义的 FSRS 调度层（学习步 / fuzz / 逻辑日，纯函数）
pub mod mastery; // 掌握度中间层（A-P0 回流画像 + A-P1 FSRS 调度偏置）
pub mod study_loop; // 学习闭环：媒体转写制卡/出题出处 + 学习时长（docs/dev/media-learning §3）
