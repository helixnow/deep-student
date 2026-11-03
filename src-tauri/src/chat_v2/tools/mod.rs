//! Chat V2 工具模块（app 门面）。
//!
//! step 10 L5：执行器框架（`ToolExecutor` / `ExecutionContext` / 注册表 / 注入器）与
//! agent-core / agent-platform 执行器已迁到 dstu-agent 的 `chat_v2::tools`，这里整体重导出，
//! 所有 `crate::chat_v2::tools::…` 路径保持不变。
//!
//! 下面声明的是留在 app 的 38 个域执行器（anki / qbank / notes / research / tutor /
//! media / sync / memory / learning / vision / office / handwriting）。它们实现旧版 `ToolExecutor`，
//! 经 `agent_wiring::roster::AppExecutorRoster` 注入 pipeline，分发顺序与拆分前逐字一致；
//! 之后（W5）随各域迁入对应 domain crate。

pub use dstu_agent::chat_v2::tools::*;

pub mod academic_search_executor; // 🆕 学术论文搜索执行器（arXiv + OpenAlex）
pub mod attachment_executor; // 🆕 附件工具执行器（解决 P0 断裂点）
pub mod browser_executor; // 🆕 内置浏览器 Agent 工具（BrowserService + 注入桥；非 Playwright）
pub mod builtin_resource_executor; // 🆕 内置学习资源工具执行器
pub mod builtin_retrieval_executor; // 🆕 内置检索工具执行器（MCP 工具化）
pub mod canvas_executor;
pub mod chatanki_executor; // 🆕 ChatAnki 工具执行器（文件→卡片闭环）
pub mod chatanki_transform; // 🆕 chatanki_transform 声明式变换引擎（ops 模式纯 Rust）
pub mod chatanki_transform_script; // 🆕 chatanki_transform 沙箱脚本模式（temp root job 目录 + 平台沙箱 + I/O 合同）
pub mod data_governance_executor; // Agent-safe backup and sync tools
pub mod document_processing_executor; // 🆕 文档解析/OCR 主动触发执行器（document_parse/status）
pub mod docx_executor; // 🆕 DOCX 文档读写工具执行器（docx-rs 完整能力）
pub mod dstu_executor; // DSTU/VFS Finder mutation and trash tools
pub mod essay_grading_executor; // 🆕 作文批改工具执行器（essay_grade 异步任务 + 历史查询）
pub mod fsrs_settings_executor; // 🆕 闪卡 FSRS 调度设置工具执行器（get/update，与设置面板同源）
pub mod generative_ui_executor; // 🆕 生成式 UI 工具执行器（render_generative_ui）
pub mod image_generation_executor; // 🆕 内置图片生成工具执行器
pub mod index_webpage_executor; // VFS index inspection/rebuild and webpage archive tools
pub mod ink_executor; // Ink handwriting tools
pub mod insight_recall_executor; // 🆕 灵感召回工具执行器（Insight Recall v2 阶段二）
pub mod knowledge_executor; // 🆕 知识工具执行器（内化/提取）
pub mod learning_overview_executor; // Read-only learning overview and Pomodoro statistics
pub mod media_executor; // Managed attachment audio transcription
pub mod memory_executor;
pub mod notes_import_executor; // 🆕 笔记库 zip 导入执行器（staged zip → NotesImporter）
pub mod office_fidelity_executor; // Read-only OOXML/PDF fidelity inventory and completion gate
pub mod office_output; // Shared VFS/workspace delivery for generated OOXML files
pub mod paper_save_executor; // 🆕 论文保存+引用格式化工具执行器
pub mod pptx_executor; // 🆕 PPTX 演示文稿读写工具执行器（ppt-rs）
pub mod qbank_executor; // 🆕 智能题目集工具执行器
pub(crate) mod qbank_import_source; // qbank_import_document 输入解析（content / 资源库 resource_id）
pub mod review_executor; // 🆕 间隔重复复习计划工具执行器（review_* 工具组，SM-2）
pub mod settings_models_executor; // Agent-safe settings and model assignment tools
pub mod template_executor; // 🆕 模板设计师工具执行器
pub mod textbook_pdf_executor; // Agent-safe textbook annotations and PDF page images
pub mod translation_executor; // Translation pipeline + explicit VFS save tools
pub mod user_todo_executor;
pub mod xlsx_executor; // 🆕 XLSX 电子表格读写工具执行器（umya-spreadsheet）

// 重导出域执行器（与拆分前 tools/mod.rs 的同名重导出一致）
pub use academic_search_executor::AcademicSearchExecutor; // 🆕 学术论文搜索执行器
pub use attachment_executor::AttachmentToolExecutor; // 🆕 附件工具执行器
pub use browser_executor::BrowserToolExecutor; // 🆕 内置浏览器 Agent 工具执行器
pub use builtin_resource_executor::BuiltinResourceExecutor; // 🆕 内置学习资源工具执行器
pub use builtin_retrieval_executor::BuiltinRetrievalExecutor; // 🆕 内置检索工具执行器
pub use canvas_executor::CanvasToolExecutor;
pub use chatanki_executor::ChatAnkiToolExecutor; // 🆕 ChatAnki 工具执行器
pub use data_governance_executor::DataGovernanceToolExecutor;
pub use document_processing_executor::DocumentProcessingExecutor; // 🆕 文档解析/OCR 主动触发执行器
pub use docx_executor::DocxToolExecutor; // 🆕 DOCX 文档读写工具执行器
pub use dstu_executor::DstuToolExecutor;
pub use essay_grading_executor::EssayGradingExecutor; // 🆕 作文批改工具执行器
pub use fsrs_settings_executor::FsrsSettingsExecutor; // 🆕 闪卡 FSRS 调度设置工具执行器
pub use generative_ui_executor::GenerativeUiExecutor; // 🆕 生成式 UI 工具执行器
pub use image_generation_executor::ImageGenerationExecutor; // 🆕 内置图片生成工具执行器
pub use index_webpage_executor::IndexWebpageToolExecutor;
pub use ink_executor::InkToolExecutor;
pub use insight_recall_executor::InsightRecallExecutor; // 🆕 灵感召回工具执行器
pub use knowledge_executor::KnowledgeExecutor; // 🆕 知识工具执行器
pub use learning_overview_executor::LearningOverviewExecutor;
pub use media_executor::MediaToolExecutor;
pub use memory_executor::MemoryToolExecutor;
pub use office_fidelity_executor::OfficeFidelityExecutor;
pub use paper_save_executor::PaperSaveExecutor; // 🆕 论文保存+引用格式化工具执行器
pub use pptx_executor::PptxToolExecutor; // 🆕 PPTX 演示文稿读写工具执行器
pub use review_executor::ReviewToolExecutor; // 🆕 间隔重复复习计划工具执行器
pub use settings_models_executor::SettingsModelsToolExecutor;
pub use template_executor::TemplateDesignerExecutor; // 🆕 模板设计师工具执行器
pub use textbook_pdf_executor::TextbookPdfToolExecutor;
pub use translation_executor::TranslationToolExecutor;
pub use user_todo_executor::UserTodoExecutor;
pub use xlsx_executor::XlsxToolExecutor; // 🆕 XLSX 电子表格读写工具执行器
