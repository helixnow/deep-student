//! Deep Student 笔记域 crate（domain 层）。
//!
//! `notes_manager`（笔记 CRUD、链接/标签、Canvas 结构操作、Lance 全文索引）与
//! `notes_exporter`（笔记 Markdown/ZIP 导入导出、资产与历史）。笔记的数据层
//! （vfs.db 中的 note/revision/format/relation/lease 等仓储）在 dstu-vfs。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_notes::xxx` 保留原路径。`cmd::notes` 命令依赖 app 的 `AppState`，
//! 仍留在 app；依赖 app 组合根的笔记历史单测在 app 的 `notes_app_tests`。

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::models;
use dstu_storage::{database, file_manager};
use dstu_vfs::vfs;

// 仅 notes_manager 的 Lance 分支使用，按同样的 cfg 引入避免未使用告警。
#[cfg(feature = "lance")]
use dstu_vfs::lance_vector_store;

#[allow(dead_code)]
pub mod notes_exporter;
pub mod notes_manager;
