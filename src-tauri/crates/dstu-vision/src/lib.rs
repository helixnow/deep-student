//! Deep Student 视觉 / 文档理解能力 crate。
//!
//! 题目集导入流水线的各阶段：页面栅格化（`page_rasterizer`）、VLM 题目定位
//! （`vlm_grounding_service`）、跨页合并（`cross_page_merger`）、插图裁切
//! （`figure_extractor`）、LLM 结构化（`llm_structurer`），以及 PDF OCR 服务
//! （`pdf_ocr_service`）与题目集识别会话服务（`exam_sheet_service`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_vision::xxx` 保留原路径。`exam_engine`（`impl LLMManager` 的 OCR
//! 方法块）留在 dstu-llm。

// 与 app 相同的宏展开余量（VLM 请求体 / OCR 进度事件的 json! 块）。
#![recursion_limit = "512"]

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{models, prompt_contracts};
use dstu_docs::{document_parser, pdfium_utils};
use dstu_llm::{llm_manager, ocr_adapters, providers};
use dstu_storage::{database, file_manager};
use dstu_util::utils;
use dstu_vfs::vfs;

pub mod cross_page_merger;
#[allow(dead_code)]
pub mod exam_sheet_service;
pub mod figure_extractor;
pub mod llm_structurer;
pub mod page_rasterizer;
pub mod pdf_ocr_service;
pub mod vlm_grounding_service;
