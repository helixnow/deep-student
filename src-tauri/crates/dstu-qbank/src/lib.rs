//! Deep Student 题库域 crate（服务层）。
//!
//! 题目集出题/录题/导入导出、AI 出题与评判、练习与组卷、复习计划、旧数据收敛等服务。
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过 `pub use dstu_qbank::xxx`
//! 保留原路径。仍留在 app 的部分：
//! - `commands.rs` 中题库相关命令（取 `State<'_, AppState>`）；
//! - `qbank_generation` / `qbank_grading` / `qbank_practice` 中取 `State<'_, AppState>` 的
//!   `#[tauri::command]` 薄包装（业务体在本 crate，经 [`runtime::QbankState`] 传入依赖）；
//! - `qbank_read`（读取逻辑在 dstu-vfs）与依赖 memory / data_governance / extensions 的单测。

// 与 app 一致：大型 json! 块需要更深的宏展开余量。
#![recursion_limit = "512"]

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{models, prompt_contracts, spaced_repetition};
use dstu_docs::{document_parser, docx_handout};
use dstu_learning::{mastery, study_loop};
use dstu_llm::{llm_manager, providers};
use dstu_platform::{background_tasks, debug_log_service};
use dstu_storage::{data_space, file_manager};
use dstu_util::utils;
use dstu_vfs::vfs;
use dstu_vision::{
    cross_page_merger, figure_extractor, llm_structurer, page_rasterizer, vlm_grounding_service,
};

// app lib.rs 的 `pub use vfs::question_sync_service;` 别名。
use dstu_vfs::vfs::question_sync_service;

// 仅单测使用。
#[cfg(test)]
use dstu_storage::database;
#[cfg(test)]
use dstu_vision::exam_sheet_service;

pub mod qbank_authoring_service;
pub mod qbank_document;
pub mod qbank_generation;
pub mod qbank_grading;
pub mod qbank_legacy_reconcile;
pub mod qbank_management;
pub mod qbank_practice;
pub mod qbank_source_view;
pub mod question_authoring_runner;
#[allow(dead_code)]
pub mod question_bank_service;
pub mod question_export_service;
#[allow(dead_code)]
pub mod question_import_service;
pub mod review_plan_service; // 复习计划服务（与错题系统集成）
pub mod runtime; // 命令/后台任务的运行期依赖（AppState 字段，由 app 注入）
