//! Deep Student 文档读写 crate。
//!
//! 文档解析与生成（`document_parser`）、讲义模板 DOCX（`docx_handout`）、
//! Pdfium 库加载与 PDF 文本提取（`pdfium_utils`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致，app 通过
//! `pub use dstu_docs::xxx` 保留原路径。

#![recursion_limit = "512"]

#[allow(dead_code)]
pub mod document_parser;
pub mod docx_handout;
pub mod pdfium_utils; // Pdfium 公共工具（库加载 + 文本提取）
