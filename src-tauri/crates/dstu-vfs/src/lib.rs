//! Deep Student 虚拟文件系统服务层 crate。
//!
//! VFS 统一资源存储（`vfs`：`vfs.db` 连接池、各表仓储 `repos/`、索引与检索、
//! PDF 预处理流水线、Lance 向量存储、低层回调注册点 `hooks`）、DSTU 访达协议层
//! （`dstu`）、教材库（`textbooks_db`）、向量存储（`vector_store` /
//! `lance_vector_store`），以及 `pdfstream://` / `filestream://` 协议处理
//! （`pdf_protocol` / `file_stream_protocol`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_vfs::xxx` 保留原路径（`generate_handler!` 与协议注册路径不变）。
//!
//! memory / media / qbank 等上层业务域通过 `vfs::hooks` 的 `Slot` / `HookSet`
//! 回调接入，由 app 的 `extensions::register_extensions()` 接线；迁移 SQL 仍在
//! `src-tauri/migrations/`（由 `dstu-storage` 的迁移协调器内嵌）。

// 大型 json! 构造块（检索结果 / 题目上下文 / 导出清单）需要更深的宏展开余量。
#![recursion_limit = "512"]

pub mod dstu;
pub mod file_stream_protocol; // filestream:// 通用媒体/blob 流式加载协议（复用 pdfstream 安全模式）
#[allow(dead_code)]
pub mod lance_vector_store;
pub mod pdf_protocol;
pub mod textbooks_db;
pub mod vector_store;
#[allow(dead_code, deprecated)]
pub mod vfs; // VFS 虚拟文件系统（统一资源存储） // DSTU 访达协议层（VFS 的文件系统语义接口）

// 拆分前这些模块通过 `crate::X` 引用低层 crate 的模块，这里保留原路径，
// 使搬过来的文件里的 `crate::<module>` 不需要改写。
pub(crate) use dstu_core::{error_details, media_types, models};
pub(crate) use dstu_docs::{document_parser, pdfium_utils};
pub(crate) use dstu_llm::{llm_manager, multimodal, ocr_adapters};
pub(crate) use dstu_platform::background_tasks;
pub(crate) use dstu_storage::{
    data_space, database, file_manager, llm_usage, staged_upload, unified_file_manager,
};
pub(crate) use dstu_util::utils;
