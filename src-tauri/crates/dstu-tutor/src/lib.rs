//! Deep Student 辅导域 crate。
//!
//! - `essay_grading`：作文批改独立流式管线（会话/轮次走 VFS 统一存储，自定义批阅模式 JSON 存储）
//! - `translation`：翻译独立流式管线（standalone 翻译、多候选译文、聊天浮窗翻译）
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致。前端命令（`#[tauri::command]`）
//! 依赖 app 的 `AppState`，仍以薄包装留在 app 的 `essay_grading` / `translation` 模块，
//! 由这里的同名函数承载命令逻辑；app 模块通过 `pub use dstu_tutor::xxx::*` 保留其余原路径。

// 大型 json! 请求体（批改/翻译 provider 请求）需要更深的宏展开余量（与 app 一致）。
#![recursion_limit = "512"]

pub mod essay_grading;
pub mod translation;

// 拆分前这些模块通过 `crate::X` 引用低层 crate 的模块，这里保留原路径，
// 使搬过来的文件里的 `crate::<module>` 不需要改写。
pub(crate) use dstu_core::{models, prompt_contracts};
pub(crate) use dstu_llm::{llm_manager, providers};
pub(crate) use dstu_storage::database;
pub(crate) use dstu_util::utils;
pub(crate) use dstu_vfs::vfs;
