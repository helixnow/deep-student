//! 题目导入服务 — Visual-First 统一管线
//!
//! 以 VLM 视觉分析为核心的导入架构：
//! 1. Stage 1 (PageRasterizer): 所有文档 → 高清页面图片
//! 2. Stage 2 (VlmAnalyzer): VLM 逐页分析 → 题目文本 + 配图 bbox
//! 3. Stage 3 (CrossPageMerger): 跨页题目检测与合并
//! 4. Stage 4 (FigureExtractor): 按 bbox 裁切配图 → VFS 存储 → 精确关联
//! 5. Stage 5 (LlmStructurer): VLM raw_text → 标准题目 JSON
//! 6. Stage 6 (Persistence): SAVEPOINT 事务写入
//!
//! 另保留独立的 CSV 导入功能（CsvImportService）。

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

use crate::cross_page_merger;
use crate::document_parser::DocumentParser;
use crate::figure_extractor;
use crate::file_manager::FileManager;
use crate::llm_manager::LLMManager;
use crate::llm_structurer::LlmStructurer;
use crate::models::{
    AppError, ExamCardPreview, ExamSheetPreviewPage, ExamSheetPreviewResult,
    QuestionStatus, SourceType,
};
use crate::page_rasterizer::{PageRasterizer, PageSlice};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    CreateQuestionParams, QuestionFilters, QuestionImage, VfsBlobRepo, VfsExamRepo,
    VfsQuestionRepo,
};
use crate::vfs::types::VfsCreateExamSheetParams;
use crate::vlm_grounding_service::{VlmExtractedQuestion, VlmGroundingService, VlmPageAnalysis};

// ============================================================================
// 公共类型
// ============================================================================

/// 流式导入进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum QuestionImportProgress {
    /// 文档预处理进度（解码、解析、图片提取等 — session 创建之前的阶段）
    Preprocessing {
        stage: String,
        message: String,
        percent: usize,
    },
    /// 页面渲染进度
    RenderingPages {
        current: usize,
        total: usize,
    },
    /// 单张图片 OCR/VLM 完成（兼容旧前端事件名）
    OcrImageCompleted {
        image_index: usize,
        total_images: usize,
    },
    /// OCR/VLM 阶段完成
    OcrPhaseCompleted {
        total_images: usize,
        total_chars: usize,
    },
    /// 导入会话已创建
    SessionCreated {
        session_id: String,
        name: String,
        total_chunks: usize,
    },
    /// 配图提取进度
    ExtractingFigures {
        current: usize,
        total: usize,
    },
    /// 题目结构化进度
    StructuringQuestion {
        current: usize,
        total: usize,
    },
    /// 单道题目解析完成
    QuestionParsed {
        question: Value,
        question_index: usize,
        total_parsed: usize,
    },
    /// 分块完成（兼容旧前端）
    ChunkStart {
        chunk_index: usize,
        total_chunks: usize,
    },
    ChunkCompleted {
        chunk_index: usize,
        total_chunks: usize,
        questions_in_chunk: usize,
        total_parsed: usize,
    },
    /// 导入完成
    Completed {
        session_id: String,
        name: String,
        total_questions: usize,
    },
    /// 导入失败
    Failed {
        session_id: Option<String>,
        error: String,
        total_parsed: usize,
    },
}

/// 导入请求参数（兼容现有 commands.rs 接口）
#[derive(Debug, Clone)]
pub struct ImportRequest {
    pub content: String,
    pub format: String,
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub folder_id: Option<String>,
    pub model_config_id: Option<String>,
    /// 保留兼容性（Visual-First 架构下忽略此字段）
    pub pdf_prefer_ocr: Option<bool>,
}

/// 导入结果
#[derive(Debug, Clone)]
pub struct ImportResult {
    pub session_id: String,
    pub name: String,
    pub imported_count: usize,
    pub total_questions: usize,
}

/// PDF 文本检测结果（保留向后兼容，新架构下不再需要前端调用）
#[derive(Debug, Clone, Serialize)]
pub struct PdfTextInspection {
    pub valid_char_count: usize,
    pub total_char_count: usize,
    pub preview_text: String,
    pub recommendation: String,
}

/// 管线阶段标识（用于断点续导的状态机）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ImportStage {
    Rasterized,
    VlmAnalyzing,
    VlmCompleted,
    FiguresExtracted,
    Structuring,
    Completed,
    // DOCX 原生路径阶段（旧 text+marker 方案）
    DocxExtracted,
    DocxVlmDescribing,
    DocxVlmDone,
    DocxStructuring,
    // DOCX VLM 直提路径阶段
    DocxVlmDirect,
    DocxVlmDirectDone,
}

impl Default for ImportStage {
    fn default() -> Self {
        Self::Rasterized
    }
}

/// 断点续导状态（分阶段 checkpoint 状态机）
///
/// 每完成一个 Stage 的关键进度就持久化，恢复时跳到正确阶段：
/// - `VlmAnalyzing` + `vlm_pages_completed` → 从断点页继续 VLM
/// - `VlmCompleted` → 跳过 VLM，从 Stage 3 开始
/// - `Structuring` + `structuring_batches_completed` → 从断点批次继续 LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCheckpointState {
    pub qbank_name: String,
    pub model_config_id: Option<String>,
    pub source_format: String,
    #[serde(default)]
    pub current_stage: ImportStage,
    /// 页面图片的 VFS blob hash 列表
    pub page_blob_hashes: Vec<String>,

    // Stage 2: VLM 分析
    #[serde(default)]
    pub vlm_pages_completed: usize,
    #[serde(default)]
    pub vlm_page_results: Vec<String>,

    // Stage 5: LLM 结构化
    #[serde(default)]
    pub structuring_batches_completed: usize,
    /// 已完成批次的 LLM 结构化结果（每个元素为一批题目的 JSON 数组字符串）
    #[serde(default)]
    pub structured_batch_results: Vec<String>,

    // Stage 4: 页面尺寸（恢复时避免解码图片）
    #[serde(default)]
    pub page_dimensions: Vec<(u32, u32)>,

    // 向后兼容旧 checkpoint
    #[serde(default)]
    pub source_image_hashes: Vec<String>,
    #[serde(default)]
    pub import_mode: String,
    #[serde(default)]
    pub text_content: String,
    #[serde(default)]
    pub chunks_total: usize,
    #[serde(default)]
    pub chunks_completed: usize,

    // DOCX 原生路径专用（旧 text+marker）
    #[serde(default)]
    pub docx_image_entries: Vec<DocxImageEntrySerde>,
    #[serde(default)]
    pub docx_vlm_descriptions: HashMap<String, String>,
    #[serde(default)]
    pub docx_vlm_images_completed: usize,
    #[serde(default)]
    pub docx_enriched_text: String,
    #[serde(default)]
    pub docx_marker_positions: Vec<(usize, usize)>,

    // DOCX VLM 直提路径专用
    #[serde(default)]
    pub docx_vlm_direct_blob_hashes: Vec<String>,
    #[serde(default)]
    pub docx_vlm_direct_mimes: Vec<String>,
    #[serde(default)]
    pub docx_vlm_direct_exts: Vec<String>,
    #[serde(default)]
    pub docx_vlm_direct_text: String,
    #[serde(default)]
    pub docx_vlm_direct_saved: usize,
}

// ============================================================================
// 导入服务
// ============================================================================

pub struct QuestionImportService {
    llm_manager: Arc<LLMManager>,
    file_manager: Option<Arc<FileManager>>,
}

impl QuestionImportService {
    pub fn new(llm_manager: Arc<LLMManager>, file_manager: Arc<FileManager>) -> Self {
        Self {
            llm_manager,
            file_manager: Some(file_manager),
        }
    }

    pub fn new_without_file_manager(llm_manager: Arc<LLMManager>) -> Self {
        Self {
            llm_manager,
            file_manager: None,
        }
    }

    /// 保留向后兼容
    pub fn inspect_pdf_text(&self, base64_content: &str) -> Result<PdfTextInspection, AppError> {
        let parser = DocumentParser::new();
        let extracted = parser
            .extract_text_from_base64("document.pdf", base64_content)
            .map_err(|e| AppError::validation(format!("文档解析失败: {}", e)))?;

        let normalized = extracted.trim();
        let valid_char_count = count_valid_chars(normalized);
        let total_char_count = normalized.chars().count();
        let recommendation = if valid_char_count < 100 {
            "auto_ocr"
        } else if valid_char_count < 500 {
            "manual_decision"
        } else {
            "use_text"
        }
        .to_string();

        Ok(PdfTextInspection {
            valid_char_count,
            total_char_count,
            preview_text: normalized.chars().take(800).collect(),
            recommendation,
        })
    }

    /// 非流式导入入口
    pub async fn import_document(
        &self,
        vfs_db: &VfsDatabase,
        request: ImportRequest,
    ) -> Result<ImportResult, AppError> {
        self.import_document_stream(vfs_db, request, None).await
    }

    /// Visual-First 统一导入管线（流式）
    pub async fn import_document_stream(
        &self,
        vfs_db: &VfsDatabase,
        request: ImportRequest,
        progress_tx: Option<UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        let format = request.format.as_str();

        // JSON 直接导入（无需 VLM）
        if format == "json" {
            return self.import_json_directly(vfs_db, &request).await;
        }

        // 纯文本 & 表格格式：走 LLM 结构化（无图片，VLM 无意义）
        if matches!(format, "txt" | "md" | "markdown" | "csv" | "xlsx" | "xls") {
            return self
                .import_text_via_llm(vfs_db, &request, progress_tx.as_ref())
                .await;
        }

        // ====== DOCX：原生提取 + VLM 直提（无需 LibreOffice） ======
        if format == "docx" {
            // 快速检测是否含嵌入图片
            let has_images = match decode_base64_content(&request.content) {
                Ok(ref docx_bytes) => {
                    let parser = DocumentParser::new();
                    match parser.extract_docx_with_images(docx_bytes) {
                        Ok((_, images)) => !images.is_empty(),
                        Err(_) => false,
                    }
                }
                Err(_) => false,
            };

            if has_images {
                // 有图片 DOCX → VLM 直接提取（VLM 看到真实图片，自行判断图文关联）
                log::info!("[QuestionImport] DOCX 含嵌入图片，走 VLM 直提路径");
                return self
                    .import_docx_via_vlm(vfs_db, &request, progress_tx.as_ref())
                    .await;
            } else {
                // 纯文本 DOCX → LLM 结构化
                log::info!("[QuestionImport] DOCX 无嵌入图片，走纯文本路径");
                return self
                    .import_text_via_llm(vfs_db, &request, progress_tx.as_ref())
                    .await;
            }
        }

        // ====== Visual-First 管线：PDF / Image ======

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "rasterizing".to_string(),
                message: "正在渲染文档页面...".to_string(),
                percent: 2,
            });
        }

        // Stage 1: 渲染为页面图片
        let pages = match self
            .stage1_rasterize(vfs_db, &request, progress_tx.as_ref())
            .await
        {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => {
                return Err(AppError::validation("文档渲染后没有生成任何页面"));
            }
            Err(e) => return Err(e),
        };

        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        let session_id =
            self.create_import_session(vfs_db, &request, &qbank_name, &pages)?;

        // 初始 checkpoint（Stage 1 完成）
        let mut checkpoint = ImportCheckpointState {
            qbank_name: qbank_name.clone(),
            model_config_id: request.model_config_id.clone(),
            source_format: request.format.clone(),
            current_stage: ImportStage::Rasterized,
            page_blob_hashes: pages.iter().map(|p| p.blob_hash.clone()).collect(),
            vlm_pages_completed: 0,
            vlm_page_results: Vec::new(),
            structuring_batches_completed: 0,
            structured_batch_results: Vec::new(),
            page_dimensions: pages.iter().map(|p| (p.width, p.height)).collect(),
            source_image_hashes: Vec::new(),
            import_mode: String::new(),
            text_content: String::new(),
            chunks_total: 0,
            chunks_completed: 0,
            docx_image_entries: Vec::new(),
            docx_vlm_descriptions: HashMap::new(),
            docx_vlm_images_completed: 0,
            docx_enriched_text: String::new(),
            docx_marker_positions: Vec::new(),
            docx_vlm_direct_blob_hashes: Vec::new(),
            docx_vlm_direct_mimes: Vec::new(),
            docx_vlm_direct_exts: Vec::new(),
            docx_vlm_direct_text: String::new(),
            docx_vlm_direct_saved: 0,
        };
        save_checkpoint(vfs_db, &session_id, &checkpoint);

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::SessionCreated {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_chunks: pages.len(),
            });
        }

        // Stage 2-6: 共享流程
        self.run_visual_pipeline_from_stage2(
            vfs_db,
            &session_id,
            &qbank_name,
            &pages,
            &mut checkpoint,
            0, // vlm 从 0 开始
            progress_tx.as_ref(),
        )
        .await
    }

    /// 恢复中断的导入（分阶段 checkpoint 状态机）
    pub async fn resume_import(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        progress_tx: Option<UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        let state_str = VfsExamRepo::get_import_state(vfs_db, session_id)
            .map_err(|e| AppError::database(format!("读取导入状态失败: {}", e)))?
            .ok_or_else(|| AppError::not_found("未找到可恢复的导入状态"))?;

        let mut checkpoint: ImportCheckpointState = serde_json::from_str(&state_str)
            .map_err(|e| AppError::validation(format!("解析导入状态失败: {}", e)))?;

        log::info!(
            "[QuestionImport] 恢复导入: session={}, stage={:?}, vlm={}/{}, struct_batches={}",
            session_id,
            checkpoint.current_stage,
            checkpoint.vlm_pages_completed,
            checkpoint.page_blob_hashes.len(),
            checkpoint.structuring_batches_completed,
        );

        // DOCX 原生路径：通过 stage 前缀 Docx* 检测
        let is_docx_native = matches!(
            checkpoint.current_stage,
            ImportStage::DocxExtracted
                | ImportStage::DocxVlmDescribing
                | ImportStage::DocxVlmDone
                | ImportStage::DocxStructuring
        );

        // DOCX VLM 直提路径恢复
        let is_docx_vlm_direct = matches!(
            checkpoint.current_stage,
            ImportStage::DocxVlmDirect | ImportStage::DocxVlmDirectDone
        );

        if is_docx_vlm_direct {
            let blob_hashes = checkpoint.docx_vlm_direct_blob_hashes.clone();
            let mime_list = checkpoint.docx_vlm_direct_mimes.clone();
            let ext_list = checkpoint.docx_vlm_direct_exts.clone();
            let clean_text = checkpoint.docx_vlm_direct_text.clone();
            let already_saved = checkpoint.docx_vlm_direct_saved;
            let qbank_name = checkpoint.qbank_name.clone();

            log::info!(
                "[QuestionImport] 恢复 DOCX VLM 直提: session={}, stage={:?}, 已保存={}, blobs={}",
                session_id,
                checkpoint.current_stage,
                already_saved,
                blob_hashes.len()
            );

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::SessionCreated {
                    session_id: session_id.to_string(),
                    name: qbank_name.clone(),
                    total_chunks: 1,
                });
            }

            // DocxVlmDirectDone 表示 VLM 已完成，直接 finalize
            if checkpoint.current_stage == ImportStage::DocxVlmDirectDone {
                rebuild_preview_from_questions(vfs_db, session_id);
                let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
                let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);
                if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, session_id) {
                    log::warn!("[QuestionImport] 统计刷新失败: {}", e);
                }
                if let Some(ref tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::Completed {
                        session_id: session_id.to_string(),
                        name: qbank_name.clone(),
                        total_questions: already_saved,
                    });
                }
                return Ok(ImportResult {
                    session_id: session_id.to_string(),
                    name: qbank_name,
                    imported_count: already_saved,
                    total_questions: already_saved,
                });
            }

            // DocxVlmDirect: 重建 data URL，从 VLM 调用处恢复
            let mut data_urls: Vec<String> = Vec::with_capacity(blob_hashes.len());
            for (idx, hash) in blob_hashes.iter().enumerate() {
                let mime = mime_list.get(idx).map(|s| s.as_str()).unwrap_or("image/png");
                match VfsBlobRepo::get_blob_path(vfs_db, hash) {
                    Ok(Some(path)) => match std::fs::read(&path) {
                        Ok(blob_data) => {
                            use base64::Engine;
                            let b64 =
                                base64::engine::general_purpose::STANDARD.encode(&blob_data);
                            data_urls.push(format!("data:{};base64,{}", mime, b64));
                        }
                        Err(e) => {
                            log::warn!(
                                "[QuestionImport] 恢复时读取 blob 文件失败: {}: {}",
                                path.display(),
                                e
                            );
                            data_urls.push(String::new());
                        }
                    },
                    _ => {
                        log::warn!("[QuestionImport] 恢复时找不到 blob: {}", hash);
                        data_urls.push(String::new());
                    }
                }
            }

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Preprocessing {
                    stage: "vlm_extracting".to_string(),
                    message: format!(
                        "恢复 VLM 提取: {} 张图片, 已保存 {} 题...",
                        data_urls.len(),
                        already_saved
                    ),
                    percent: 20,
                });
            }

            let total_saved = self.run_vlm_direct_extraction(
                vfs_db,
                session_id,
                &data_urls,
                &blob_hashes,
                &mime_list,
                &ext_list,
                &clean_text,
                &mut checkpoint,
                already_saved,
                progress_tx.as_ref(),
            ).await?;

            rebuild_preview_from_questions(vfs_db, session_id);

            let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
            let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);
            if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, session_id) {
                log::warn!("[QuestionImport] 统计刷新失败: {}", e);
            }
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Completed {
                    session_id: session_id.to_string(),
                    name: qbank_name.clone(),
                    total_questions: total_saved,
                });
            }
            return Ok(ImportResult {
                session_id: session_id.to_string(),
                name: qbank_name,
                imported_count: total_saved,
                total_questions: total_saved,
            });
        }

        if is_docx_native {
            // 从 checkpoint 恢复 image_map
            let image_map: Vec<DocxImageEntry> = checkpoint
                .docx_image_entries
                .iter()
                .map(DocxImageEntry::from)
                .collect();
            let has_images = !image_map.is_empty();
            let vlm_start = checkpoint.docx_vlm_images_completed;

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::SessionCreated {
                    session_id: session_id.to_string(),
                    name: checkpoint.qbank_name.clone(),
                    total_chunks: image_map.len() + 1,
                });
            }

            return self
                .run_docx_pipeline_from_vlm(
                    vfs_db,
                    session_id,
                    &image_map,
                    has_images,
                    &mut checkpoint,
                    vlm_start,
                    progress_tx.as_ref(),
                )
                .await;
        }

        // 纯文本路径恢复：通过 import_mode == "text" 检测
        if checkpoint.import_mode == "text" && !checkpoint.text_content.is_empty() {
            log::info!(
                "[QuestionImport] 恢复纯文本导入: session={}, chunks={}/{}",
                session_id,
                checkpoint.chunks_completed,
                checkpoint.chunks_total,
            );

            let text_content = checkpoint.text_content.clone();
            let qbank_name = checkpoint.qbank_name.clone();
            let max_tokens_per_chunk = 6000;
            let estimated_tokens = text_content.chars().count() / 2;
            let chunks = if estimated_tokens <= max_tokens_per_chunk {
                vec![text_content.clone()]
            } else {
                segment_document(&text_content, max_tokens_per_chunk)
            };
            let total_chunks = chunks.len();
            let chunks_start = checkpoint.chunks_completed;

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::SessionCreated {
                    session_id: session_id.to_string(),
                    name: qbank_name.clone(),
                    total_chunks,
                });
            }

            // 从已有题目数恢复 total_parsed
            let mut total_parsed = VfsQuestionRepo::list_questions(
                vfs_db,
                session_id,
                &QuestionFilters::default(),
                1,
                1,
            )
            .map(|r| r.total as usize)
            .unwrap_or(0);

            let mut all_questions: Vec<Value> = Vec::new();

            for (chunk_idx, chunk) in chunks.iter().enumerate() {
                if chunk_idx < chunks_start {
                    continue;
                }

                if let Some(ref tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::ChunkStart {
                        chunk_index: chunk_idx,
                        total_chunks,
                    });
                }

                let prompt = build_text_parse_prompt(chunk);
                let mut questions_in_chunk = 0;

                let chunk_questions = self
                    .llm_manager
                    .call_llm_for_question_parsing_streaming(
                        &prompt,
                        checkpoint.model_config_id.as_deref(),
                        |q: Value| {
                            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
                            if content.trim().is_empty() {
                                return true;
                            }

                            let card_id = format!("card_{}", nanoid::nanoid!(12));
                            let params = json_to_question_params(
                                &q,
                                session_id,
                                &card_id,
                                total_parsed,
                            );

                            if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                                log::warn!("[QuestionImport] 保存题目失败: {}", e);
                            }

                            total_parsed += 1;
                            questions_in_chunk += 1;

                            if let Some(ref tx) = progress_tx {
                                let _ = tx.send(QuestionImportProgress::QuestionParsed {
                                    question: q.clone(),
                                    question_index: total_parsed - 1,
                                    total_parsed,
                                });
                            }

                            true
                        },
                    )
                    .await;

                match chunk_questions {
                    Ok(questions) => {
                        all_questions.extend(questions);
                    }
                    Err(e) => {
                        log::warn!("[QuestionImport] 块 {} 解析失败: {}", chunk_idx + 1, e);
                    }
                }

                checkpoint.chunks_completed = chunk_idx + 1;
                save_checkpoint(vfs_db, session_id, &checkpoint);

                if let Some(ref tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::ChunkCompleted {
                        chunk_index: chunk_idx,
                        total_chunks,
                        questions_in_chunk,
                        total_parsed,
                    });
                }
            }

            if total_parsed == 0 {
                let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
                let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);
                return Err(AppError::validation("未能提取到题目"));
            }

            rebuild_preview_from_questions(vfs_db, session_id);

            let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
            let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);

            if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, session_id) {
                log::warn!("[QuestionImport] 统计刷新失败: {}", e);
            }

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Completed {
                    session_id: session_id.to_string(),
                    name: qbank_name.clone(),
                    total_questions: total_parsed,
                });
            }

            return Ok(ImportResult {
                session_id: session_id.to_string(),
                name: qbank_name,
                imported_count: total_parsed,
                total_questions: total_parsed,
            });
        }

        // Visual-First 管线恢复
        let pages = rebuild_pages_from_checkpoint(&checkpoint, vfs_db)?;
        let vlm_start = checkpoint.vlm_pages_completed;
        let qbank_name = checkpoint.qbank_name.clone();

        self.run_visual_pipeline_from_stage2(
            vfs_db,
            session_id,
            &qbank_name,
            &pages,
            &mut checkpoint,
            vlm_start,
            progress_tx.as_ref(),
        )
        .await
    }

    /// Stage 2 ~ Stage 6 共享流程（首次导入和恢复复用同一逻辑）
    async fn run_visual_pipeline_from_stage2(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        qbank_name: &str,
        pages: &[PageSlice],
        checkpoint: &mut ImportCheckpointState,
        vlm_start_page: usize,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        // ===== Stage 2: VLM 逐页分析（带 checkpoint） =====
        checkpoint.current_stage = ImportStage::VlmAnalyzing;
        save_checkpoint(vfs_db, session_id, checkpoint);

        let vlm_service = VlmGroundingService::new(self.llm_manager.clone());

        // 恢复已完成的 VLM 结果
        let mut page_analyses: Vec<Option<VlmPageAnalysis>> = checkpoint
            .vlm_page_results
            .iter()
            .map(|s| {
                if s.trim().is_empty() {
                    None
                } else {
                    serde_json::from_str(s).ok()
                }
            })
            .collect();

        // 从断点页开始继续
        for idx in vlm_start_page..pages.len() {
            let page = &pages[idx];

            match vlm_service.analyze_page_by_blob(vfs_db, page).await {
                Ok(analysis) => {
                    log::info!(
                        "[QuestionImport] VLM 页面 {}/{}: {} 道题目",
                        idx + 1,
                        pages.len(),
                        analysis.questions.len()
                    );
                    while page_analyses.len() <= idx {
                        page_analyses.push(None);
                    }
                    let json_str = serde_json::to_string(&analysis).unwrap_or_default();
                    while checkpoint.vlm_page_results.len() <= idx {
                        checkpoint.vlm_page_results.push(String::new());
                    }
                    checkpoint.vlm_page_results[idx] = json_str;
                    page_analyses[idx] = Some(analysis);
                }
                Err(e) => {
                    log::warn!("[QuestionImport] VLM 页面 {} 失败: {}", idx + 1, e);
                    while page_analyses.len() <= idx {
                        page_analyses.push(None);
                    }
                    while checkpoint.vlm_page_results.len() <= idx {
                        checkpoint.vlm_page_results.push(String::new());
                    }
                }
            }

            // 逐页更新 checkpoint
            checkpoint.vlm_pages_completed = idx + 1;
            save_checkpoint(vfs_db, session_id, checkpoint);

            if let Some(tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::OcrImageCompleted {
                    image_index: idx,
                    total_images: pages.len(),
                });
            }
        }

        checkpoint.current_stage = ImportStage::VlmCompleted;
        save_checkpoint(vfs_db, session_id, checkpoint);

        let total_ocr_chars: usize = page_analyses
            .iter()
            .filter_map(|a| a.as_ref())
            .flat_map(|a| a.questions.iter())
            .map(|q| q.raw_text.len())
            .sum();

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::OcrPhaseCompleted {
                total_images: pages.len(),
                total_chars: total_ocr_chars,
            });
        }

        // ===== Stage 3: 跨页合并 =====
        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "merging".to_string(),
                message: "正在跨页合并题目...".to_string(),
                percent: 42,
            });
        }
        let merged = cross_page_merger::merge_pages(&page_analyses);

        if merged.is_empty() {
            if let Some(tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Failed {
                    session_id: Some(session_id.to_string()),
                    error: "VLM 分析未能提取到题目".to_string(),
                    total_parsed: 0,
                });
            }
            let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
            return Err(AppError::validation("VLM 分析未能提取到题目"));
        }

        // ===== Stage 4: 配图裁切与关联 =====
        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::ExtractingFigures {
                current: 0,
                total: merged.len(),
            });
        }
        let questions_with_figures =
            figure_extractor::extract_figures(merged, pages, vfs_db);

        checkpoint.current_stage = ImportStage::FiguresExtracted;
        save_checkpoint(vfs_db, session_id, checkpoint);

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::ExtractingFigures {
                current: questions_with_figures.len(),
                total: questions_with_figures.len(),
            });
        }

        // ===== Stage 5: LLM 结构化（带逐批 checkpoint） =====
        checkpoint.current_stage = ImportStage::Structuring;
        save_checkpoint(vfs_db, session_id, checkpoint);

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::StructuringQuestion {
                current: checkpoint.structuring_batches_completed,
                total: questions_with_figures.len(),
            });
        }

        let structurer = LlmStructurer::new(self.llm_manager.clone());
        let (batches_done, batch_jsons, structured) = structurer
            .structure_questions(
                &questions_with_figures,
                checkpoint.model_config_id.as_deref(),
                checkpoint.structuring_batches_completed,
                &checkpoint.structured_batch_results,
            )
            .await?;

        checkpoint.structuring_batches_completed = batches_done;
        checkpoint.structured_batch_results = batch_jsons;
        save_checkpoint(vfs_db, session_id, checkpoint);

        // ===== Stage 6: 持久化 =====
        self.persist_structured_questions(
            vfs_db,
            session_id,
            qbank_name,
            &structured,
            pages,
            progress_tx,
        )
    }

    // ====== 内部方法 ======

    /// Stage 1: 渲染文档为页面图片
    ///
    /// DOCX 转换失败时返回 `Err(ImportResult)` 表示已通过文本模式完成导入。
    async fn stage1_rasterize(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<Vec<PageSlice>, AppError> {
        let format = request.format.as_str();

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::RenderingPages {
                current: 0,
                total: 1,
            });
        }

        let result = match format {
            "pdf" => PageRasterizer::rasterize_pdf(&request.content, vfs_db),
            "docx" => PageRasterizer::rasterize_docx(&request.content, vfs_db),
            fmt if is_image_format(fmt) => {
                PageRasterizer::rasterize_images(&request.content, vfs_db)
            }
            _ => {
                return Err(AppError::validation(format!(
                    "不支持的导入格式: {}",
                    format
                )));
            }
        }?;

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::RenderingPages {
                current: result.pages.len(),
                total: result.pages.len(),
            });
        }

        Ok(result.pages)
    }

    /// DOCX 图文混合导入 — VLM 直接提取全部题目（流式逐题 + 断点续导）
    ///
    /// 将 DOCX 中的所有嵌入图片 + 提取文本一起发给 VLM，
    /// 由 VLM 直接看到真实图片并判断图片与题目的对应关系。
    /// 完全绕过 text+marker 方案，从根本上消除图片-题目错配问题。
    ///
    /// **流式**：VLM 每输出一道完整题目就立即保存 + 发送 QuestionParsed 事件
    /// **断点续导**：图片提取后保存 checkpoint，崩溃后可从 VLM 调用处恢复
    async fn import_docx_via_vlm(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        // ===== Stage 1: 提取文本 + 嵌入图片 =====
        log::info!(
            "[QuestionImport] DOCX VLM 直提路径开始: content 长度={} 字符",
            request.content.len()
        );

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "decoding".to_string(),
                message: "正在解码文档...".to_string(),
                percent: 2,
            });
        }

        let docx_bytes = decode_base64_content(&request.content)?;

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "extracting".to_string(),
                message: "正在提取文本和图片...".to_string(),
                percent: 5,
            });
        }

        let parser = DocumentParser::new();
        let (extracted_text, image_bytes_list) = parser
            .extract_docx_with_images(&docx_bytes)
            .map_err(|e| AppError::validation(format!("DOCX 解析失败: {}", e)))?;

        let total_images = image_bytes_list.len();
        log::info!(
            "[QuestionImport] DOCX 提取完成: {} 字符, {} 张图片",
            extracted_text.len(),
            total_images
        );

        // ===== 图片存 VFS blob + 构建 data URL =====
        let mut blob_hashes: Vec<String> = Vec::with_capacity(total_images);
        let mut data_urls: Vec<String> = Vec::with_capacity(total_images);
        let mut mime_list: Vec<String> = Vec::with_capacity(total_images);
        let mut ext_list: Vec<String> = Vec::with_capacity(total_images);

        for (idx, img_bytes) in image_bytes_list.iter().enumerate() {
            if img_bytes.is_empty() {
                continue;
            }

            if let Some(tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Preprocessing {
                    stage: "storing_images".to_string(),
                    message: format!("正在存储图片 {}/{}...", idx + 1, total_images),
                    percent: 5 + (idx * 10) / total_images.max(1),
                });
            }

            let (mime, ext) = detect_image_format(img_bytes);
            let blob = VfsBlobRepo::store_blob(vfs_db, img_bytes, Some(mime), Some(ext))
                .map_err(|e| AppError::database(format!("图片 {} Blob 存储失败: {}", idx, e)))?;

            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(img_bytes);
            let url = format!("data:{};base64,{}", mime, b64);

            blob_hashes.push(blob.hash);
            data_urls.push(url);
            mime_list.push(mime.to_string());
            ext_list.push(ext.to_string());
        }

        // 去掉文本中的 <<IMG:N>> 标记（VLM 能直接看到图片，不需要标记）
        let clean_text = regex::Regex::new(r"<<IMG:\d+>>")
            .unwrap()
            .replace_all(&extracted_text, "[图片]")
            .to_string();

        // ===== 创建会话 =====
        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        let session_id = if let Some(sid) = &request.session_id {
            sid.clone()
        } else {
            let temp_id = uuid::Uuid::new_v4().to_string();
            let preview = ExamSheetPreviewResult {
                temp_id: temp_id.clone(),
                exam_name: Some(qbank_name.clone()),
                pages: vec![ExamSheetPreviewPage {
                    page_index: 0,
                    cards: Vec::new(),
                    blob_hash: None,
                    width: None,
                    height: None,
                    original_image_path: String::new(),
                    raw_ocr_text: None,
                    ocr_completed: false,
                    parse_completed: false,
                }],
                raw_model_response: None,
                instructions: None,
                session_id: Some(temp_id.clone()),
            };
            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

            let params = VfsCreateExamSheetParams {
                exam_name: Some(qbank_name.clone()),
                temp_id,
                metadata_json: json!({}),
                preview_json,
                status: "importing".to_string(),
                folder_id: request.folder_id.clone(),
            };
            VfsExamRepo::create_exam_sheet(vfs_db, params)
                .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?
                .id
        };

        // ===== 保存 checkpoint: DocxVlmDirect（图片已提取，准备 VLM 调用） =====
        let mut checkpoint = ImportCheckpointState {
            qbank_name: qbank_name.clone(),
            model_config_id: request.model_config_id.clone(),
            source_format: "docx".to_string(),
            current_stage: ImportStage::DocxVlmDirect,
            page_blob_hashes: Vec::new(),
            vlm_pages_completed: 0,
            vlm_page_results: Vec::new(),
            structuring_batches_completed: 0,
            structured_batch_results: Vec::new(),
            page_dimensions: Vec::new(),
            source_image_hashes: Vec::new(),
            import_mode: String::new(),
            text_content: String::new(),
            chunks_total: 0,
            chunks_completed: 0,
            docx_image_entries: Vec::new(),
            docx_vlm_descriptions: HashMap::new(),
            docx_vlm_images_completed: 0,
            docx_enriched_text: String::new(),
            docx_marker_positions: Vec::new(),
            docx_vlm_direct_blob_hashes: blob_hashes.clone(),
            docx_vlm_direct_mimes: mime_list.clone(),
            docx_vlm_direct_exts: ext_list.clone(),
            docx_vlm_direct_text: clean_text.clone(),
            docx_vlm_direct_saved: 0,
        };
        save_checkpoint(vfs_db, &session_id, &checkpoint);

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::SessionCreated {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_chunks: 1,
            });
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "vlm_extracting".to_string(),
                message: format!(
                    "正在用 VLM 分析 {} 张图片和文本，提取题目...",
                    data_urls.len()
                ),
                percent: 20,
            });
        }

        // ===== Stage 2: VLM 流式提取 → 逐题保存 =====
        let total_saved = self.run_vlm_direct_extraction(
            vfs_db,
            &session_id,
            &data_urls,
            &blob_hashes,
            &mime_list,
            &ext_list,
            &clean_text,
            &mut checkpoint,
            0, // start from question 0
            progress_tx,
        ).await?;

        // ===== 完成 =====
        rebuild_preview_from_questions(vfs_db, &session_id);

        let _ = VfsExamRepo::update_status(vfs_db, &session_id, "completed");
        let _ = VfsExamRepo::clear_import_state(vfs_db, &session_id);

        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &session_id) {
            log::warn!("[QuestionImport] 统计刷新失败: {}", e);
        }

        if let Some(tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Completed {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_questions: total_saved,
            });
        }

        log::info!(
            "[QuestionImport] DOCX VLM 直提完成: {} 道题目, session={}",
            total_saved,
            session_id
        );

        Ok(ImportResult {
            session_id,
            name: qbank_name,
            imported_count: total_saved,
            total_questions: total_saved,
        })
    }

    /// VLM 直提核心逻辑（可从 import_docx_via_vlm 和 resume 两处调用）
    ///
    /// 使用流式回调逐题保存 + 更新 checkpoint。
    /// `skip_count`: 已保存的题目数（恢复时跳过前 N 题）。
    async fn run_vlm_direct_extraction(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        data_urls: &[String],
        blob_hashes: &[String],
        mime_list: &[String],
        ext_list: &[String],
        clean_text: &str,
        checkpoint: &mut ImportCheckpointState,
        skip_count: usize,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<usize, AppError> {
        let vlm_service = VlmGroundingService::new(Arc::clone(&self.llm_manager));

        let mut total_saved = skip_count;
        let mut vlm_question_index: usize = 0;

        let vlm_result = vlm_service
            .extract_docx_questions_stream(data_urls, clean_text, |vq| {
                vlm_question_index += 1;

                // 恢复时跳过已保存的题目
                if vlm_question_index <= skip_count {
                    return true;
                }

                if vq.content.trim().is_empty() {
                    return true;
                }

                let card_id = format!("card_{}", nanoid::nanoid!(12));

                // 关联图片：为每个 blob 创建/复用 VFS file 条目，使前端可加载
                let question_images: Vec<QuestionImage> = vq
                    .image_indices
                    .iter()
                    .filter_map(|&img_idx| {
                        if img_idx < blob_hashes.len() {
                            let img_name = format!(
                                "docx_image_{}.{}",
                                img_idx,
                                ext_list.get(img_idx).unwrap_or(&"png".to_string())
                            );
                            let img_mime = mime_list
                                .get(img_idx)
                                .unwrap_or(&"image/png".to_string())
                                .clone();
                            let file_id = ensure_vfs_file_for_blob(
                                vfs_db,
                                &blob_hashes[img_idx],
                                &img_name,
                                &img_mime,
                            )
                            .unwrap_or_else(|| format!("file_{}", nanoid::nanoid!(10)));
                            Some(QuestionImage {
                                id: file_id,
                                name: img_name,
                                mime: img_mime,
                                hash: blob_hashes[img_idx].clone(),
                            })
                        } else {
                            None
                        }
                    })
                    .collect();

                let q_json = serde_json::to_value(&vq).unwrap_or_default();
                let mut params =
                    json_to_question_params(&q_json, session_id, &card_id, total_saved);

                if !question_images.is_empty() {
                    params.images = Some(question_images);
                }

                if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                    log::warn!(
                        "[QuestionImport] 保存题目 {} 失败: {}",
                        vlm_question_index,
                        e
                    );
                    return true; // 跳过失败的题目，继续处理
                }

                total_saved += 1;

                // 更新 checkpoint
                checkpoint.docx_vlm_direct_saved = total_saved;
                save_checkpoint(vfs_db, session_id, checkpoint);

                // 发送实时进度
                if let Some(tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::QuestionParsed {
                        question: q_json,
                        question_index: total_saved - 1,
                        total_parsed: total_saved,
                    });
                }

                true // 继续处理
            })
            .await;

        match vlm_result {
            Ok(vlm_count) => {
                log::info!(
                    "[QuestionImport] VLM 流式提取完成: VLM 输出 {} 题, 实际保存 {} 题",
                    vlm_count,
                    total_saved
                );
            }
            Err(e) => {
                log::error!("[QuestionImport] VLM DOCX 提取失败: {}", e);
                // 如果已保存部分题目，不算完全失败
                if total_saved > skip_count {
                    log::warn!(
                        "[QuestionImport] 已保存 {} 道题目（部分成功）",
                        total_saved
                    );
                } else {
                    if let Some(tx) = progress_tx {
                        let _ = tx.send(QuestionImportProgress::Failed {
                            session_id: Some(session_id.to_string()),
                            error: format!("VLM 提取失败: {}", e),
                            total_parsed: total_saved,
                        });
                    }
                    return Err(e);
                }
            }
        }

        // 标记 VLM 提取完成
        checkpoint.current_stage = ImportStage::DocxVlmDirectDone;
        checkpoint.docx_vlm_direct_saved = total_saved;
        save_checkpoint(vfs_db, session_id, checkpoint);

        if total_saved == 0 {
            if let Some(tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Failed {
                    session_id: Some(session_id.to_string()),
                    error: "VLM 未能提取到任何题目".to_string(),
                    total_parsed: 0,
                });
            }
            return Err(AppError::validation("VLM 未能提取到任何题目"));
        }

        Ok(total_saved)
    }

    /// [DEPRECATED] DOCX 原生导入路径 — text+marker 方案，已被 import_docx_via_vlm 取代
    ///
    /// 阶段状态机：DocxExtracted → DocxVlmDescribing → DocxVlmDone → DocxStructuring → Completed
    /// 每个阶段完成后持久化 checkpoint，崩溃后可从断点恢复。
    #[allow(dead_code)]
    async fn import_docx_with_images(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        // ===== Stage 1: 提取文本 + 嵌入图片 =====
        log::info!(
            "[QuestionImport] DOCX 原生路径开始: content 长度={} 字符",
            request.content.len()
        );

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "decoding".to_string(),
                message: "正在解码文档...".to_string(),
                percent: 2,
            });
        }

        let docx_bytes = decode_base64_content(&request.content).map_err(|e| {
            log::error!("[QuestionImport] DOCX Base64 解码失败: {}", e);
            e
        })?;

        log::info!(
            "[QuestionImport] DOCX 二进制解码完成: {} bytes",
            docx_bytes.len()
        );

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "extracting".to_string(),
                message: "正在提取文本和图片...".to_string(),
                percent: 5,
            });
        }

        let parser = DocumentParser::new();
        let (text_with_markers, image_bytes_list) = parser
            .extract_docx_with_images(&docx_bytes)
            .map_err(|e| {
                log::error!("[QuestionImport] DOCX 解析失败: {}", e);
                AppError::validation(format!("DOCX 解析失败: {}", e))
            })?;

        if text_with_markers.trim().is_empty() && image_bytes_list.is_empty() {
            return Err(AppError::validation("DOCX 文档内容为空"));
        }

        let has_images = !image_bytes_list.is_empty();
        log::info!(
            "[QuestionImport] DOCX 原生提取: {} 字符, {} 张嵌入图片",
            text_with_markers.len(),
            image_bytes_list.len()
        );

        // ===== 图片存 VFS blob =====
        let total_to_store = image_bytes_list.len();
        let mut image_map: Vec<DocxImageEntry> = Vec::with_capacity(total_to_store);
        for (idx, img_bytes) in image_bytes_list.iter().enumerate() {
            if img_bytes.is_empty() {
                continue;
            }

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Preprocessing {
                    stage: "storing_images".to_string(),
                    message: format!("正在存储图片 {}/{}...", idx + 1, total_to_store),
                    percent: 8 + (idx * 12) / total_to_store.max(1),
                });
            }

            let (mime, ext) = detect_image_format(img_bytes);
            let blob = VfsBlobRepo::store_blob(vfs_db, img_bytes, Some(mime), Some(ext))
                .map_err(|e| {
                    AppError::database(format!("图片 {} Blob 存储失败: {}", idx, e))
                })?;
            image_map.push(DocxImageEntry {
                marker_index: idx,
                blob_hash: blob.hash.clone(),
                mime: mime.to_string(),
                ext: ext.to_string(),
            });
        }

        // ===== 创建会话 =====
        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "creating_session".to_string(),
                message: "正在创建导入会话...".to_string(),
                percent: 20,
            });
        }

        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        let session_id = if let Some(sid) = &request.session_id {
            sid.clone()
        } else {
            let temp_id = uuid::Uuid::new_v4().to_string();
            let preview = ExamSheetPreviewResult {
                temp_id: temp_id.clone(),
                exam_name: Some(qbank_name.clone()),
                pages: vec![ExamSheetPreviewPage {
                    page_index: 0,
                    cards: Vec::new(),
                    blob_hash: None,
                    width: None,
                    height: None,
                    original_image_path: String::new(),
                    raw_ocr_text: None,
                    ocr_completed: false,
                    parse_completed: false,
                }],
                raw_model_response: None,
                instructions: None,
                session_id: Some(temp_id.clone()),
            };
            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

            let params = VfsCreateExamSheetParams {
                exam_name: Some(qbank_name.clone()),
                temp_id,
                metadata_json: json!({}),
                preview_json,
                status: "importing".to_string(),
                folder_id: request.folder_id.clone(),
            };
            let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
                .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
            exam_sheet.id
        };

        // ===== 初始 checkpoint（DocxExtracted） =====
        let mut checkpoint = ImportCheckpointState {
            qbank_name: qbank_name.clone(),
            model_config_id: request.model_config_id.clone(),
            source_format: "docx".to_string(),
            current_stage: ImportStage::DocxExtracted,
            page_blob_hashes: Vec::new(),
            vlm_pages_completed: 0,
            vlm_page_results: Vec::new(),
            structuring_batches_completed: 0,
            structured_batch_results: Vec::new(),
            page_dimensions: Vec::new(),
            source_image_hashes: Vec::new(),
            import_mode: String::new(),
            text_content: text_with_markers.clone(),
            chunks_total: 0,
            chunks_completed: 0,
            docx_image_entries: image_map.iter().map(DocxImageEntrySerde::from).collect(),
            docx_vlm_descriptions: HashMap::new(),
            docx_vlm_images_completed: 0,
            docx_enriched_text: String::new(),
            docx_marker_positions: Vec::new(),
            docx_vlm_direct_blob_hashes: Vec::new(),
            docx_vlm_direct_mimes: Vec::new(),
            docx_vlm_direct_exts: Vec::new(),
            docx_vlm_direct_text: String::new(),
            docx_vlm_direct_saved: 0,
        };
        save_checkpoint(vfs_db, &session_id, &checkpoint);

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::SessionCreated {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_chunks: image_bytes_list.len() + 1, // VLM + LLM 阶段
            });
        }

        // ===== 从 Stage 2 开始执行 =====
        self.run_docx_pipeline_from_vlm(
            vfs_db,
            &session_id,
            &image_map,
            has_images,
            &mut checkpoint,
            0, // vlm 从 0 开始
            progress_tx,
        )
        .await
    }

    /// DOCX 原生路径：从 VLM 描述阶段开始执行（首次和恢复复用）
    async fn run_docx_pipeline_from_vlm(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        image_map: &[DocxImageEntry],
        has_images: bool,
        checkpoint: &mut ImportCheckpointState,
        vlm_start_idx: usize,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        let qbank_name = checkpoint.qbank_name.clone();
        let total_images = image_map.len();

        // ===== Stage 2: VLM 逐图描述（带 checkpoint） =====
        if checkpoint.current_stage == ImportStage::DocxExtracted
            || checkpoint.current_stage == ImportStage::DocxVlmDescribing
        {
            checkpoint.current_stage = ImportStage::DocxVlmDescribing;
            save_checkpoint(vfs_db, session_id, checkpoint);

            if has_images {
                let vlm_service = VlmGroundingService::new(Arc::clone(&self.llm_manager));

                for idx in vlm_start_idx..total_images {
                    let entry = &image_map[idx];

                    // 通知前端 VLM 进度
                    if let Some(ref tx) = progress_tx {
                        let _ = tx.send(QuestionImportProgress::OcrImageCompleted {
                            image_index: idx,
                            total_images,
                        });
                    }

                    // 从 blob 加载图片字节用于 VLM
                    let img_bytes = match crate::page_rasterizer::load_page_image_bytes(
                        vfs_db,
                        &entry.blob_hash,
                    ) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            log::warn!(
                                "[QuestionImport] 图片 {} blob 加载失败: {}",
                                idx,
                                e
                            );
                            checkpoint.docx_vlm_images_completed = idx + 1;
                            save_checkpoint(vfs_db, session_id, checkpoint);
                            continue;
                        }
                    };

                    log::info!(
                        "[QuestionImport] VLM 描述图片 {}/{} ({}, {} bytes)",
                        idx + 1,
                        total_images,
                        entry.mime,
                        img_bytes.len()
                    );

                    match vlm_service.describe_image(&img_bytes).await {
                        Ok(desc) if !desc.is_empty() => {
                            // 安全处理：转义 >> 并截断到 500 字符
                            let safe_desc = sanitize_vlm_description(&desc, 500);
                            let preview: String = safe_desc.chars().take(80).collect();
                            log::info!(
                                "[QuestionImport] 图片 {} VLM 描述: {}...",
                                idx,
                                preview
                            );
                            checkpoint
                                .docx_vlm_descriptions
                                .insert(idx.to_string(), safe_desc);
                        }
                        Ok(_) => {
                            log::warn!("[QuestionImport] 图片 {} VLM 返回空描述", idx);
                        }
                        Err(e) => {
                            log::warn!("[QuestionImport] 图片 {} VLM 描述失败: {}", idx, e);
                        }
                    }

                    // 逐图保存 checkpoint
                    checkpoint.docx_vlm_images_completed = idx + 1;
                    save_checkpoint(vfs_db, session_id, checkpoint);
                }

                if let Some(ref tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::OcrPhaseCompleted {
                        total_images,
                        total_chars: checkpoint
                            .docx_vlm_descriptions
                            .values()
                            .map(|d| d.len())
                            .sum(),
                    });
                }
            }

            // ===== 构建 VLM 增强文本 =====
            let enriched_text = build_enriched_text(
                &checkpoint.text_content,
                &checkpoint.docx_vlm_descriptions,
            );

            // 记录标记位置
            let marker_positions = extract_marker_positions(&enriched_text);

            checkpoint.docx_enriched_text = enriched_text;
            checkpoint.docx_marker_positions = marker_positions;
            checkpoint.current_stage = ImportStage::DocxVlmDone;
            save_checkpoint(vfs_db, session_id, checkpoint);
        }

        // ===== Stage 3: LLM 结构化（带逐块 checkpoint） =====
        let enriched_text = &checkpoint.docx_enriched_text;
        let marker_positions = &checkpoint.docx_marker_positions;

        let max_tokens_per_chunk = 6000;
        let estimated_tokens = enriched_text.chars().count() / 2;
        let chunks = if estimated_tokens <= max_tokens_per_chunk {
            vec![enriched_text.clone()]
        } else {
            segment_document(enriched_text, max_tokens_per_chunk)
        };
        let total_chunks = chunks.len();
        checkpoint.chunks_total = total_chunks;

        // 跳过已完成的 chunks（断点恢复）
        let chunks_start = checkpoint.chunks_completed;

        checkpoint.current_stage = ImportStage::DocxStructuring;
        save_checkpoint(vfs_db, session_id, checkpoint);

        let mut total_parsed = if chunks_start > 0 {
            // 恢复时从已有题目数开始
            VfsQuestionRepo::list_questions(
                vfs_db,
                session_id,
                &QuestionFilters::default(),
                1,
                1,
            )
            .map(|r| r.total as usize)
            .unwrap_or(0)
        } else {
            0
        };

        let mut question_text_offsets: Vec<(usize, usize)> = Vec::new();
        let mut chunk_char_offset: usize =
            chunks.iter().take(chunks_start).map(|c| c.len()).sum();

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            if chunk_idx < chunks_start {
                continue;
            }

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::ChunkStart {
                    chunk_index: chunk_idx,
                    total_chunks,
                });
            }

            let prompt = if has_images {
                build_text_parse_prompt_with_images(chunk)
            } else {
                build_text_parse_prompt(chunk)
            };

            let chunk_start_offset = chunk_char_offset;
            let mut questions_in_chunk = 0;

            let chunk_questions = self
                .llm_manager
                .call_llm_for_question_parsing_streaming(
                    &prompt,
                    checkpoint.model_config_id.as_deref(),
                    |q: Value| {
                        let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        if content.trim().is_empty() {
                            return true;
                        }

                        let card_id = format!("card_{}", nanoid::nanoid!(12));

                        let question_images = if has_images {
                            extract_images_from_question_json(&q, image_map)
                        } else {
                            Vec::new()
                        };

                        if has_images {
                            // 尝试在 chunk 中定位题干文本的实际位置
                            let snippet: String = content.chars().take(30).collect();
                            let local_pos = if snippet.len() >= 6 {
                                chunk.find(&snippet).unwrap_or(
                                    (questions_in_chunk * chunk.len())
                                        / (questions_in_chunk + 1).max(1),
                                )
                            } else {
                                (questions_in_chunk * chunk.len())
                                    / (questions_in_chunk + 1).max(1)
                            };
                            question_text_offsets
                                .push((total_parsed, chunk_start_offset + local_pos));
                        }

                        let mut params = json_to_question_params(
                            &q, session_id, &card_id, total_parsed,
                        );

                        if !question_images.is_empty() {
                            params.images = Some(question_images);
                        }

                        clean_image_markers_in_params(&mut params);

                        if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                            log::warn!("[QuestionImport] 保存题目失败: {}", e);
                        }

                        total_parsed += 1;
                        questions_in_chunk += 1;

                        if let Some(ref tx) = progress_tx {
                            let _ = tx.send(QuestionImportProgress::QuestionParsed {
                                question: q.clone(),
                                question_index: total_parsed - 1,
                                total_parsed,
                            });
                        }

                        true
                    },
                )
                .await;

            if let Err(e) = chunk_questions {
                log::warn!(
                    "[QuestionImport] DOCX 块 {} 解析失败: {}",
                    chunk_idx + 1,
                    e
                );
            }

            chunk_char_offset += chunk.len();

            // 逐块保存 checkpoint
            checkpoint.chunks_completed = chunk_idx + 1;
            save_checkpoint(vfs_db, session_id, checkpoint);

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::ChunkCompleted {
                    chunk_index: chunk_idx,
                    total_chunks,
                    questions_in_chunk,
                    total_parsed,
                });
            }
        }

        // ===== Stage 4: 兜底关联孤儿图片 =====
        if has_images && total_parsed > 0 {
            self.associate_orphan_images(
                vfs_db,
                session_id,
                image_map,
                marker_positions,
                &question_text_offsets,
            );
        }

        // ===== 完成：清理 checkpoint =====
        if total_parsed == 0 {
            let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
            let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Failed {
                    session_id: Some(session_id.to_string()),
                    error: "未能提取到题目".to_string(),
                    total_parsed: 0,
                });
            }
            return Err(AppError::validation("未能提取到题目"));
        }

        let _ = VfsExamRepo::update_status(vfs_db, session_id, "completed");
        let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);

        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, session_id) {
            log::warn!("[QuestionImport] 统计刷新失败: {}", e);
        }

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Completed {
                session_id: session_id.to_string(),
                name: qbank_name.clone(),
                total_questions: total_parsed,
            });
        }

        Ok(ImportResult {
            session_id: session_id.to_string(),
            name: qbank_name,
            imported_count: total_parsed,
            total_questions: total_parsed,
        })
    }

    /// 兜底关联：LLM 丢弃了图片标记时，按原文位置将孤儿图片关联到最近的前驱题目
    fn associate_orphan_images(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        image_map: &[DocxImageEntry],
        marker_positions: &[(usize, usize)],
        question_offsets: &[(usize, usize)],
    ) {
        let questions = match VfsQuestionRepo::list_questions(
            vfs_db,
            session_id,
            &QuestionFilters::default(),
            1,
            10000,
        ) {
            Ok(result) => result.questions,
            Err(_) => return,
        };

        // 收集已关联的图片 hash
        let mut claimed_hashes: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for q in &questions {
            for img in &q.images {
                claimed_hashes.insert(img.hash.clone());
            }
        }

        let orphans: Vec<&DocxImageEntry> = image_map
            .iter()
            .filter(|e| !claimed_hashes.contains(&e.blob_hash))
            .collect();

        if orphans.is_empty() {
            return;
        }

        log::info!(
            "[QuestionImport] DOCX 图片兜底关联: {} 张孤儿图片",
            orphans.len()
        );

        if questions.is_empty() || question_offsets.is_empty() {
            return;
        }

        let mut updates: HashMap<String, Vec<QuestionImage>> = HashMap::new();

        for orphan in &orphans {
            let marker_pos = marker_positions
                .iter()
                .find(|(idx, _)| *idx == orphan.marker_index)
                .map(|(_, pos)| *pos);

            let target_q_idx = if let Some(pos) = marker_pos {
                let mut best = 0usize;
                for &(q_idx, q_offset) in question_offsets {
                    if q_offset <= pos {
                        best = q_idx;
                    }
                }
                best
            } else {
                0
            };

            if let Some(question) = questions.get(target_q_idx) {
                let img = QuestionImage {
                    id: format!("img_{}", nanoid::nanoid!(10)),
                    name: format!("docx_image_{}.{}", orphan.marker_index, orphan.ext),
                    mime: orphan.mime.clone(),
                    hash: orphan.blob_hash.clone(),
                };
                updates
                    .entry(question.id.clone())
                    .or_default()
                    .push(img);
            }
        }

        for (question_id, new_images) in &updates {
            if let Some(q) = questions.iter().find(|q| &q.id == question_id) {
                let mut all_images = q.images.clone();
                all_images.extend(new_images.clone());
                let update_params = crate::vfs::repos::UpdateQuestionParams {
                    images: Some(all_images),
                    ..Default::default()
                };
                if let Err(e) =
                    VfsQuestionRepo::update_question(vfs_db, question_id, &update_params)
                {
                    log::warn!(
                        "[QuestionImport] 兜底关联图片到 {} 失败: {}",
                        question_id,
                        e
                    );
                }
            }
        }

        log::info!(
            "[QuestionImport] 兜底关联完成: {} 张图片 → {} 道题目",
            orphans.len(),
            updates.len()
        );
    }

    /// 纯文本格式的 LLM 直接解析路径
    ///
    /// 支持 txt/md/csv/xlsx/xls（纯文本解码）以及 DOCX 回退（二进制文档解析）。
    async fn import_text_via_llm(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "decoding".to_string(),
                message: "正在解析文档内容...".to_string(),
                percent: 5,
            });
        }

        let text_content = if matches!(request.format.as_str(), "docx" | "xlsx" | "xls") {
            let parser = DocumentParser::new();
            let file_name = format!("document.{}", request.format);
            parser
                .extract_text_from_base64(&file_name, &request.content)
                .map_err(|e| AppError::validation(format!("文档解析失败: {}", e)))?
        } else {
            self.decode_text_content(&request.content)?
        };

        if text_content.trim().is_empty() {
            return Err(AppError::validation("文档内容为空"));
        }

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Preprocessing {
                stage: "chunking".to_string(),
                message: format!("文档解析完成，共 {} 字符，正在分块...", text_content.chars().count()),
                percent: 15,
            });
        }

        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        // 分块
        let max_tokens_per_chunk = 6000;
        let estimated_tokens = text_content.chars().count() / 2;
        let chunks = if estimated_tokens <= max_tokens_per_chunk {
            vec![text_content.clone()]
        } else {
            segment_document(&text_content, max_tokens_per_chunk)
        };

        let total_chunks = chunks.len();

        // 创建会话
        let session_id = if let Some(sid) = &request.session_id {
            sid.clone()
        } else {
            let temp_id = uuid::Uuid::new_v4().to_string();
            let preview = ExamSheetPreviewResult {
                temp_id: temp_id.clone(),
                exam_name: Some(qbank_name.clone()),
                pages: vec![ExamSheetPreviewPage {
                    page_index: 0,
                    cards: Vec::new(),
                    blob_hash: None,
                    width: None,
                    height: None,
                    original_image_path: String::new(),
                    raw_ocr_text: None,
                    ocr_completed: false,
                    parse_completed: false,
                }],
                raw_model_response: None,
                instructions: None,
                session_id: Some(temp_id.clone()),
            };
            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

            let params = VfsCreateExamSheetParams {
                exam_name: Some(qbank_name.clone()),
                temp_id,
                metadata_json: json!({}),
                preview_json,
                status: "importing".to_string(),
                folder_id: request.folder_id.clone(),
            };
            let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
                .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
            exam_sheet.id
        };

        // 初始 checkpoint（文本路径）
        let mut checkpoint = ImportCheckpointState {
            qbank_name: qbank_name.clone(),
            model_config_id: request.model_config_id.clone(),
            source_format: request.format.clone(),
            current_stage: ImportStage::Structuring,
            page_blob_hashes: Vec::new(),
            vlm_pages_completed: 0,
            vlm_page_results: Vec::new(),
            structuring_batches_completed: 0,
            structured_batch_results: Vec::new(),
            page_dimensions: Vec::new(),
            source_image_hashes: Vec::new(),
            import_mode: "text".to_string(),
            text_content: text_content.clone(),
            chunks_total: total_chunks,
            chunks_completed: 0,
            docx_image_entries: Vec::new(),
            docx_vlm_descriptions: HashMap::new(),
            docx_vlm_images_completed: 0,
            docx_enriched_text: String::new(),
            docx_marker_positions: Vec::new(),
            docx_vlm_direct_blob_hashes: Vec::new(),
            docx_vlm_direct_mimes: Vec::new(),
            docx_vlm_direct_exts: Vec::new(),
            docx_vlm_direct_text: String::new(),
            docx_vlm_direct_saved: 0,
        };
        save_checkpoint(vfs_db, &session_id, &checkpoint);

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::SessionCreated {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_chunks,
            });
        }

        // 逐块 LLM 解析
        let mut all_questions: Vec<Value> = Vec::new();
        let mut total_parsed = 0;

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::ChunkStart {
                    chunk_index: chunk_idx,
                    total_chunks,
                });
            }

            let prompt = build_text_parse_prompt(chunk);
            let mut questions_in_chunk = 0;

            let chunk_questions = self
                .llm_manager
                .call_llm_for_question_parsing_streaming(
                    &prompt,
                    request.model_config_id.as_deref(),
                    |q: Value| {
                        let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        if content.trim().is_empty() {
                            return true;
                        }

                        let card_id = format!("card_{}", nanoid::nanoid!(12));
                        let params = json_to_question_params(
                            &q,
                            &session_id,
                            &card_id,
                            total_parsed,
                        );

                        if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                            log::warn!("[QuestionImport] 保存题目失败: {}", e);
                        }

                        total_parsed += 1;
                        questions_in_chunk += 1;

                        if let Some(ref tx) = progress_tx {
                            let _ = tx.send(QuestionImportProgress::QuestionParsed {
                                question: q.clone(),
                                question_index: total_parsed - 1,
                                total_parsed,
                            });
                        }

                        true
                    },
                )
                .await;

            match chunk_questions {
                Ok(questions) => {
                    all_questions.extend(questions);
                }
                Err(e) => {
                    log::warn!("[QuestionImport] 块 {} 解析失败: {}", chunk_idx + 1, e);
                }
            }

            // 逐块保存 checkpoint
            checkpoint.chunks_completed = chunk_idx + 1;
            save_checkpoint(vfs_db, &session_id, &checkpoint);

            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::ChunkCompleted {
                    chunk_index: chunk_idx,
                    total_chunks,
                    questions_in_chunk,
                    total_parsed,
                });
            }
        }

        if total_parsed == 0 {
            let _ = VfsExamRepo::update_status(vfs_db, &session_id, "completed");
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Failed {
                    session_id: Some(session_id.clone()),
                    error: "未能提取到题目".to_string(),
                    total_parsed: 0,
                });
            }
            return Err(AppError::validation("未能提取到题目"));
        }

        rebuild_preview_from_questions(vfs_db, &session_id);

        let _ = VfsExamRepo::update_status(vfs_db, &session_id, "completed");
        let _ = VfsExamRepo::clear_import_state(vfs_db, &session_id);

        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &session_id) {
            log::warn!("[QuestionImport] 统计刷新失败: {}", e);
        }

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Completed {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_questions: total_parsed,
            });
        }

        Ok(ImportResult {
            session_id,
            name: qbank_name,
            imported_count: total_parsed,
            total_questions: total_parsed,
        })
    }

    /// 创建导入会话记录
    fn create_import_session(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
        qbank_name: &str,
        pages: &[PageSlice],
    ) -> Result<String, AppError> {
        if let Some(sid) = &request.session_id {
            return Ok(sid.clone());
        }

        let temp_id = uuid::Uuid::new_v4().to_string();

        let preview_pages: Vec<ExamSheetPreviewPage> = pages
            .iter()
            .map(|p| ExamSheetPreviewPage {
                page_index: p.page_index,
                cards: Vec::new(),
                blob_hash: Some(p.blob_hash.clone()),
                width: Some(p.width),
                height: Some(p.height),
                original_image_path: String::new(),
                raw_ocr_text: None,
                ocr_completed: true,
                parse_completed: false,
            })
            .collect();

        let preview = ExamSheetPreviewResult {
            temp_id: temp_id.clone(),
            exam_name: Some(qbank_name.to_string()),
            pages: preview_pages,
            raw_model_response: None,
            instructions: None,
            session_id: Some(temp_id.clone()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        let params = VfsCreateExamSheetParams {
            exam_name: Some(qbank_name.to_string()),
            temp_id,
            metadata_json: json!({}),
            preview_json,
            status: "importing".to_string(),
            folder_id: request.folder_id.clone(),
        };

        let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
            .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;

        Ok(exam_sheet.id)
    }

    /// Stage 6: 持久化结构化后的题目
    fn persist_structured_questions(
        &self,
        vfs_db: &VfsDatabase,
        session_id: &str,
        qbank_name: &str,
        structured: &[crate::llm_structurer::StructuredQuestion],
        pages: &[PageSlice],
        progress_tx: Option<&UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        conn.execute("SAVEPOINT persist_questions", [])
            .map_err(|e| AppError::database(format!("创建 SAVEPOINT 失败: {}", e)))?;

        let result = (|| -> Result<usize, AppError> {
            let mut total_saved = 0;

            for (idx, sq) in structured.iter().enumerate() {
                let content = sq
                    .json
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if content.trim().is_empty() {
                    continue;
                }

                let card_id = format!("card_{}", nanoid::nanoid!(12));
                let mut params = json_to_question_params(&sq.json, session_id, &card_id, idx);
                if !sq.source.images.is_empty() {
                    params.images = Some(sq.source.images.clone());
                }

                VfsQuestionRepo::create_question_with_conn(&conn, &params)
                    .map_err(|e| AppError::database(format!("写入题目失败: {}", e)))?;

                total_saved += 1;

                if let Some(tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::QuestionParsed {
                        question: sq.json.clone(),
                        question_index: idx,
                        total_parsed: total_saved,
                    });
                }
            }

            // 更新 preview_json（带页面图片和题目卡片）
            let cards: Vec<ExamCardPreview> = structured
                .iter()
                .enumerate()
                .filter(|(_, sq)| {
                    sq.json
                        .get("content")
                        .and_then(|v| v.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false)
                })
                .map(|(i, sq)| question_to_card(&sq.json, i))
                .collect();

            let preview_pages: Vec<ExamSheetPreviewPage> = pages
                .iter()
                .map(|p| ExamSheetPreviewPage {
                    page_index: p.page_index,
                    cards: if p.page_index == 0 { cards.clone() } else { Vec::new() },
                    blob_hash: Some(p.blob_hash.clone()),
                    width: Some(p.width),
                    height: Some(p.height),
                    original_image_path: String::new(),
                    raw_ocr_text: None,
                    ocr_completed: true,
                    parse_completed: true,
                })
                .collect();

            let preview = ExamSheetPreviewResult {
                temp_id: session_id.to_string(),
                exam_name: Some(qbank_name.to_string()),
                pages: preview_pages,
                raw_model_response: None,
                instructions: None,
                session_id: Some(session_id.to_string()),
            };

            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| AppError::validation(format!("序列化 preview 失败: {}", e)))?;

            VfsExamRepo::update_preview_json_with_conn(&conn, session_id, preview_json)
                .map_err(|e| AppError::database(format!("更新 preview 失败: {}", e)))?;

            VfsExamRepo::update_status_with_conn(&conn, session_id, "completed")
                .map_err(|e| AppError::database(format!("更新状态失败: {}", e)))?;

            Ok(total_saved)
        })();

        match result {
            Ok(total_saved) => {
                conn.execute("RELEASE persist_questions", [])
                    .map_err(|e| AppError::database(format!("RELEASE 失败: {}", e)))?;

                if total_saved > 0 {
                    if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&conn, session_id) {
                        log::warn!("[QuestionImport] 统计刷新失败: {}", e);
                    }
                }

                let _ = VfsExamRepo::clear_import_state(vfs_db, session_id);

                if let Some(tx) = progress_tx {
                    let _ = tx.send(QuestionImportProgress::Completed {
                        session_id: session_id.to_string(),
                        name: qbank_name.to_string(),
                        total_questions: total_saved,
                    });
                }

                Ok(ImportResult {
                    session_id: session_id.to_string(),
                    name: qbank_name.to_string(),
                    imported_count: total_saved,
                    total_questions: total_saved,
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO persist_questions", []);
                let _ = conn.execute("RELEASE persist_questions", []);
                Err(e)
            }
        }
    }

    /// JSON 直接导入
    async fn import_json_directly(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
    ) -> Result<ImportResult, AppError> {
        let json_content = self
            .decode_text_content(&request.content)
            .unwrap_or_else(|_| request.content.clone());

        let data: Value = serde_json::from_str(&json_content)
            .map_err(|e| AppError::validation(format!("JSON 解析失败: {}", e)))?;

        let questions = data
            .get("questions")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::validation("JSON 格式错误：需要 questions 数组"))?
            .clone();

        if questions.is_empty() {
            return Err(AppError::validation("题目列表为空"));
        }

        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        let temp_id = uuid::Uuid::new_v4().to_string();
        let mut cards = Vec::new();
        let mut valid: Vec<(usize, &Value, String)> = Vec::new();

        for (i, q) in questions.iter().enumerate() {
            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                continue;
            }
            let card = question_to_card(q, i);
            let card_id = card.card_id.clone();
            cards.push(card);
            valid.push((i, q, card_id));
        }

        let preview = ExamSheetPreviewResult {
            temp_id: temp_id.clone(),
            exam_name: Some(qbank_name.clone()),
            pages: vec![ExamSheetPreviewPage {
                page_index: 0,
                cards,
                blob_hash: None,
                width: None,
                height: None,
                original_image_path: String::new(),
                raw_ocr_text: None,
                ocr_completed: false,
                parse_completed: false,
            }],
            raw_model_response: None,
            instructions: None,
            session_id: Some(temp_id.clone()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        let params = VfsCreateExamSheetParams {
            exam_name: Some(qbank_name.clone()),
            temp_id,
            metadata_json: json!({}),
            preview_json,
            status: "completed".to_string(),
            folder_id: request.folder_id.clone(),
        };

        let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
            .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;

        let session_id = exam_sheet.id;

        for (i, q, card_id) in &valid {
            let params = json_to_question_params(q, &session_id, card_id, *i);
            if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                log::warn!("[QuestionImport] JSON 导入题目 {} 失败: {}", i, e);
            }
        }

        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &session_id) {
            log::warn!("[QuestionImport] 统计刷新失败: {}", e);
        }

        let total = valid.len();
        Ok(ImportResult {
            session_id,
            name: qbank_name,
            imported_count: total,
            total_questions: total,
        })
    }

    /// 启动时检查可恢复的导入会话（供 lib.rs 启动流程调用）
    pub async fn recover_importing_sessions(
        &self,
        vfs_db: &VfsDatabase,
    ) -> Result<Vec<crate::vfs::repos::ImportingSession>, AppError> {
        VfsExamRepo::list_importing_sessions(vfs_db)
            .map_err(|e| AppError::database(format!("查询中断会话失败: {}", e)))
    }

    fn decode_text_content(&self, base64_content: &str) -> Result<String, AppError> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))?;

        if let Ok(text) = String::from_utf8(bytes.clone()) {
            let text = if text.starts_with('\u{FEFF}') {
                text[3..].to_string()
            } else {
                text
            };
            return Ok(text);
        }

        let (decoded, _, had_errors) = encoding_rs::GBK.decode(&bytes);
        if !had_errors {
            return Ok(decoded.to_string());
        }

        let (decoded, _, _) = encoding_rs::GB18030.decode(&bytes);
        Ok(decoded.to_string())
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

fn is_image_format(format: &str) -> bool {
    matches!(
        format,
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff" | "image" | "heic" | "heif"
    )
}

fn count_valid_chars(text: &str) -> usize {
    text.chars()
        .filter(|c| {
            c.is_alphanumeric()
                || ('\u{4E00}'..='\u{9FFF}').contains(c)
                || ('\u{3400}'..='\u{4DBF}').contains(c)
        })
        .count()
}

fn detect_image_format(data: &[u8]) -> (&'static str, &'static str) {
    if data.starts_with(b"\x89PNG") {
        ("image/png", "png")
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        ("image/jpeg", "jpg")
    } else if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
        ("image/webp", "webp")
    } else {
        ("image/png", "png")
    }
}

fn json_to_question_params(
    q: &Value,
    exam_id: &str,
    card_id: &str,
    index: usize,
) -> CreateQuestionParams {
    let content = q
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let options = q.get("options").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|opt| {
                let key = opt.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string();
                let content = opt.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                if key.is_empty() && content.is_empty() {
                    None
                } else {
                    Some(crate::vfs::repos::QuestionOption { key, content })
                }
            })
            .collect()
    });

    let question_type = q
        .get("question_type")
        .and_then(|v| v.as_str())
        .and_then(|t| match t.to_lowercase().as_str() {
            "single_choice" | "单选" | "单选题" => Some(crate::vfs::repos::QuestionType::SingleChoice),
            "multiple_choice" | "多选" | "多选题" => Some(crate::vfs::repos::QuestionType::MultipleChoice),
            "indefinite_choice" | "不定项" => Some(crate::vfs::repos::QuestionType::IndefiniteChoice),
            "fill_blank" | "填空" | "填空题" => Some(crate::vfs::repos::QuestionType::FillBlank),
            "short_answer" | "简答" | "简答题" => Some(crate::vfs::repos::QuestionType::ShortAnswer),
            "essay" | "论述" | "论述题" => Some(crate::vfs::repos::QuestionType::Essay),
            "calculation" | "计算" | "计算题" => Some(crate::vfs::repos::QuestionType::Calculation),
            "proof" | "证明" | "证明题" => Some(crate::vfs::repos::QuestionType::Proof),
            _ => Some(crate::vfs::repos::QuestionType::Other),
        });

    let difficulty = q.get("difficulty").and_then(|v| v.as_str()).and_then(|d| {
        match d.to_lowercase().as_str() {
            "easy" | "简单" => Some(crate::vfs::repos::Difficulty::Easy),
            "medium" | "中等" => Some(crate::vfs::repos::Difficulty::Medium),
            "hard" | "困难" => Some(crate::vfs::repos::Difficulty::Hard),
            "very_hard" | "极难" => Some(crate::vfs::repos::Difficulty::VeryHard),
            _ => None,
        }
    });

    let tags = q.get("tags").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect()
    });

    CreateQuestionParams {
        exam_id: exam_id.to_string(),
        card_id: Some(card_id.to_string()),
        question_label: Some(format!("Q{}", index + 1)),
        content,
        options,
        answer: q.get("answer").and_then(|v| v.as_str()).map(String::from),
        explanation: q.get("explanation").and_then(|v| v.as_str()).map(String::from),
        question_type,
        difficulty,
        tags,
        source_type: Some(crate::vfs::repos::SourceType::Imported),
        source_ref: None,
        images: None,
        parent_id: None,
    }
}

fn question_to_card(q: &Value, index: usize) -> ExamCardPreview {
    let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let card_id = format!("card_{}", nanoid::nanoid!(12));

    ExamCardPreview {
        card_id,
        page_index: 0,
        question_label: format!("Q{}", index + 1),
        ocr_text: content.to_string(),
        tags: q
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|t| t.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        question_type: q
            .get("question_type")
            .and_then(|v| v.as_str())
            .and_then(|t| serde_json::from_str(&format!("\"{}\"", t)).ok()),
        answer: q.get("answer").and_then(|v| v.as_str()).map(String::from),
        explanation: q.get("explanation").and_then(|v| v.as_str()).map(String::from),
        difficulty: q
            .get("difficulty")
            .and_then(|v| v.as_str())
            .and_then(|d| serde_json::from_str(&format!("\"{}\"", d)).ok()),
        status: QuestionStatus::New,
        source_type: SourceType::ImportFile,
        ..Default::default()
    }
}

fn build_text_parse_prompt(chunk: &str) -> String {
    format!(
        r#"请将以下文本内容解析为题目列表。

**文本内容**：
{}

**输出要求**：
请输出 JSON 数组格式的题目列表（只输出 JSON，不要其他任何内容）：

```json
[
  {{
    "content": "题干内容（不含选项文本）",
    "question_type": "single_choice|multiple_choice|indefinite_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "options": [
      {{"key": "A", "content": "选项A内容"}},
      {{"key": "B", "content": "选项B内容"}}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }}
]
```

**规则**：
1. 选择题必须将选项拆分到 options 数组，content 只保留题干
2. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
3. 所有数学公式用 LaTeX: 行内 $...$, 独立 $$...$$
4. difficulty 默认 "medium"
5. tags 根据知识点自动生成"#,
        chunk
    )
}

fn build_text_parse_prompt_with_images(chunk: &str) -> String {
    format!(
        r#"请将以下文本内容解析为题目列表。

**重要：文本中包含图片及其描述**
文本中的 `<<IMG:N:[图片内容: ...]>>` 标记代表文档中嵌入的图片。方括号内是该图片的视觉描述。
例如：`<<IMG:0:[图片内容: 一个直角三角形，斜边长5，一条直角边长3]>>`

你必须：
1. 利用图片描述来理解题意（图片描述等同于看到原图）
2. **原样保留**整个 `<<IMG:N:...>>` 标记在输出中的对应位置
3. 根据图片描述判断图片属于哪道题目（题干/选项/解析）

**文本内容**：
{}

**输出要求**：
请输出 JSON 数组格式的题目列表（只输出 JSON，不要其他任何内容）：

```json
[
  {{
    "content": "题干内容（保留 <<IMG:N:...>> 标记在正确位置）",
    "question_type": "single_choice|multiple_choice|indefinite_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "options": [
      {{"key": "A", "content": "选项A内容"}},
      {{"key": "B", "content": "选项B内容"}}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }}
]
```

**规则**：
1. 选择题必须将选项拆分到 options 数组，content 只保留题干
2. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
3. 所有数学公式用 LaTeX: 行内 $...$, 独立 $$...$$
4. difficulty 默认 "medium"
5. tags 根据知识点自动生成
6. **<<IMG:N:...>> 标记必须原样保留**，不要删除、修改或翻译
7. 利用图片描述理解题意，但不要将图片描述当作文字题干"#,
        chunk
    )
}

// ============================================================================
// DOCX 原生导入辅助类型与函数
// ============================================================================

/// DOCX 嵌入图片在 VFS 中的映射条目
#[derive(Debug, Clone)]
struct DocxImageEntry {
    /// 图片在原文中的 `<<IMG:N>>` 索引
    marker_index: usize,
    /// VFS blob hash
    blob_hash: String,
    /// MIME 类型
    mime: String,
    /// 文件扩展名
    ext: String,
}

/// DocxImageEntry 的可序列化版本（用于 checkpoint 持久化）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DocxImageEntrySerde {
    pub marker_index: usize,
    pub blob_hash: String,
    pub mime: String,
    pub ext: String,
}

impl From<&DocxImageEntry> for DocxImageEntrySerde {
    fn from(e: &DocxImageEntry) -> Self {
        Self {
            marker_index: e.marker_index,
            blob_hash: e.blob_hash.clone(),
            mime: e.mime.clone(),
            ext: e.ext.clone(),
        }
    }
}

impl From<&DocxImageEntrySerde> for DocxImageEntry {
    fn from(e: &DocxImageEntrySerde) -> Self {
        Self {
            marker_index: e.marker_index,
            blob_hash: e.blob_hash.clone(),
            mime: e.mime.clone(),
            ext: e.ext.clone(),
        }
    }
}

/// 用 VLM 描述替换原文中的 `<<IMG:N>>` 标记，构建增强文本
fn build_enriched_text(
    text_with_markers: &str,
    vlm_descriptions: &HashMap<String, String>,
) -> String {
    let re = Regex::new(r"<<IMG:(\d+)>>").unwrap();
    re.replace_all(text_with_markers, |caps: &regex::Captures| {
        let idx_str = &caps[1];
        if let Some(desc) = vlm_descriptions.get(idx_str) {
            format!("<<IMG:{}:[图片内容: {}]>>", idx_str, desc)
        } else {
            format!("<<IMG:{}:[图片]>>", idx_str)
        }
    })
    .to_string()
}

/// 提取增强文本中所有 `<<IMG:N:...` 标记的 (index, char_offset)
fn extract_marker_positions(enriched_text: &str) -> Vec<(usize, usize)> {
    let re = Regex::new(r"<<IMG:(\d+):").unwrap();
    re.captures_iter(enriched_text)
        .filter_map(|cap| {
            let idx: usize = cap[1].parse().ok()?;
            let pos = cap.get(0)?.start();
            Some((idx, pos))
        })
        .collect()
}

/// 对 VLM 描述文本做安全处理：
/// 1. 转义 `>>` 为 `> >` 防止截断正则
/// 2. 将换行符替换为空格，防止 segment_document 在标记 `<<IMG:N:[...]>>` 内部断开
/// 3. 截断到 max_chars 防止单个标记过大
fn sanitize_vlm_description(desc: &str, max_chars: usize) -> String {
    let escaped = desc
        .replace(">>", "> >")
        .replace('\n', " ")
        .replace('\r', " ");
    if escaped.chars().count() <= max_chars {
        escaped
    } else {
        let truncated: String = escaped.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

/// 解码 base64 内容为字节（支持 Data URL 格式）
fn decode_base64_content(content: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let base64_str = if content.starts_with("data:") {
        content
            .split(',')
            .nth(1)
            .ok_or_else(|| AppError::validation("无效的 Data URL 格式"))?
    } else {
        content
    };
    base64::engine::general_purpose::STANDARD
        .decode(base64_str)
        .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))
}

/// 从 LLM 输出的单道题 JSON 中扫描 `<<IMG:N...>>` 标记，返回关联的 QuestionImage 列表
///
/// 同时匹配两种格式：
/// - `<<IMG:N>>` — 原始标记
/// - `<<IMG:N:[图片内容: ...]>>` — VLM 增强标记
fn extract_images_from_question_json(
    q: &Value,
    image_map: &[DocxImageEntry],
) -> Vec<QuestionImage> {
    // 只需捕获索引 N，匹配任意以 <<IMG:N 开头的标记
    let re = Regex::new(r"<<IMG:(\d+)").unwrap();
    let mut found_indices: Vec<usize> = Vec::new();

    // 扫描 content
    if let Some(content) = q.get("content").and_then(|v| v.as_str()) {
        for cap in re.captures_iter(content) {
            if let Ok(idx) = cap[1].parse::<usize>() {
                found_indices.push(idx);
            }
        }
    }

    // 扫描 options
    if let Some(options) = q.get("options").and_then(|v| v.as_array()) {
        for opt in options {
            if let Some(opt_content) = opt.get("content").and_then(|v| v.as_str()) {
                for cap in re.captures_iter(opt_content) {
                    if let Ok(idx) = cap[1].parse::<usize>() {
                        found_indices.push(idx);
                    }
                }
            }
        }
    }

    // 扫描 explanation
    if let Some(explanation) = q.get("explanation").and_then(|v| v.as_str()) {
        for cap in re.captures_iter(explanation) {
            if let Ok(idx) = cap[1].parse::<usize>() {
                found_indices.push(idx);
            }
        }
    }

    // 扫描 answer（少数情况下答案也可能包含图片引用）
    if let Some(answer) = q.get("answer").and_then(|v| v.as_str()) {
        for cap in re.captures_iter(answer) {
            if let Ok(idx) = cap[1].parse::<usize>() {
                found_indices.push(idx);
            }
        }
    }

    // 去重
    found_indices.sort_unstable();
    found_indices.dedup();

    // 映射到 QuestionImage
    found_indices
        .iter()
        .filter_map(|&idx| {
            image_map
                .iter()
                .find(|e| e.marker_index == idx)
                .map(|entry| QuestionImage {
                    id: format!("img_{}", nanoid::nanoid!(10)),
                    name: format!("docx_image_{}.{}", entry.marker_index, entry.ext),
                    mime: entry.mime.clone(),
                    hash: entry.blob_hash.clone(),
                })
        })
        .collect()
}

/// 清理 CreateQuestionParams 中所有文本字段的 `<<IMG:N...>>` 标记
///
/// 同时处理两种格式：
/// - `<<IMG:N>>` → `[图N]`
/// - `<<IMG:N:[图片内容: ...]>>` → `[图N]`
///
/// 图片已作为 QuestionImage 独立关联，文本中保留简洁可读标记
fn clean_image_markers_in_params(params: &mut CreateQuestionParams) {
    // (?s) 让 . 匹配换行符，.*? 非贪婪匹配到最近的 >>
    let re = Regex::new(r"(?s)<<IMG:(\d+).*?>>").unwrap();

    params.content = re
        .replace_all(&params.content, |caps: &regex::Captures| {
            format!("[图{}]", &caps[1])
        })
        .to_string();

    if let Some(ref mut options) = params.options {
        for opt in options.iter_mut() {
            opt.content = re
                .replace_all(&opt.content, |caps: &regex::Captures| {
                    format!("[图{}]", &caps[1])
                })
                .to_string();
        }
    }

    if let Some(ref mut explanation) = params.explanation {
        *explanation = re
            .replace_all(explanation, |caps: &regex::Captures| {
                format!("[图{}]", &caps[1])
            })
            .to_string();
    }

    if let Some(ref mut answer) = params.answer {
        *answer = re
            .replace_all(answer, |caps: &regex::Captures| {
                format!("[图{}]", &caps[1])
            })
            .to_string();
    }
}

fn segment_document(content: &str, max_tokens: usize) -> Vec<String> {
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .collect();

    let paragraphs: Vec<&str> = if paragraphs.len() < 3 {
        content.split('\n').filter(|p| !p.trim().is_empty()).collect()
    } else {
        paragraphs
    };

    let mut chunks = Vec::new();
    let mut current_chunk = String::new();
    let mut current_tokens = 0;

    for para in paragraphs {
        let para_tokens = para.chars().count() / 2;

        if para_tokens > max_tokens {
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.trim().to_string());
                current_chunk.clear();
                current_tokens = 0;
            }
            let char_limit = max_tokens * 2;
            let chars: Vec<char> = para.chars().collect();
            for chunk_chars in chars.chunks(char_limit) {
                chunks.push(chunk_chars.iter().collect());
            }
            continue;
        }

        if current_tokens + para_tokens > max_tokens && !current_chunk.is_empty() {
            chunks.push(current_chunk.trim().to_string());
            current_chunk = para.to_string();
            current_tokens = para_tokens;
        } else {
            if !current_chunk.is_empty() {
                current_chunk.push_str("\n\n");
            }
            current_chunk.push_str(para);
            current_tokens += para_tokens;
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk.trim().to_string());
    }

    chunks
}

// ============================================================================
// checkpoint 辅助函数
// ============================================================================

fn save_checkpoint(vfs_db: &VfsDatabase, session_id: &str, cp: &ImportCheckpointState) {
    if let Ok(json) = serde_json::to_value(cp) {
        if let Err(e) = VfsExamRepo::update_import_state(vfs_db, session_id, &json) {
            log::warn!("[QuestionImport] 保存 checkpoint 失败: {}", e);
        }
    }
}

fn rebuild_pages_from_checkpoint(
    checkpoint: &ImportCheckpointState,
    _vfs_db: &VfsDatabase,
) -> Result<Vec<PageSlice>, AppError> {
    let mut pages = Vec::with_capacity(checkpoint.page_blob_hashes.len());

    for (idx, hash) in checkpoint.page_blob_hashes.iter().enumerate() {
        let (width, height) = checkpoint
            .page_dimensions
            .get(idx)
            .copied()
            .unwrap_or((0, 0));

        pages.push(PageSlice {
            page_index: idx,
            blob_hash: hash.clone(),
            text_hint: None,
            width,
            height,
        });
    }

    Ok(pages)
}

/// 为已存储的 blob 创建 VFS files 表条目，使前端 `vfs_get_attachment_content` 可以按 file ID 加载图片。
/// 返回生成的 file_id（`file_` 前缀）。对同一 blob_hash 重复调用是安全的（INSERT OR IGNORE）。
fn ensure_vfs_file_for_blob(
    vfs_db: &VfsDatabase,
    blob_hash: &str,
    file_name: &str,
    mime: &str,
) -> Option<String> {
    use rusqlite::OptionalExtension;

    // 先查是否已有 file 条目引用此 blob_hash
    let conn = match vfs_db.get_conn_safe() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[QuestionImport] ensure_vfs_file: 获取连接失败: {}", e);
            return None;
        }
    };

    // 查找已有的 file 条目
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM files WHERE blob_hash = ?1 AND deleted_at IS NULL LIMIT 1",
            rusqlite::params![blob_hash],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();

    if let Some(id) = existing {
        return Some(id);
    }

    // 创建新的 file 条目
    let file_id = format!("file_{}", nanoid::nanoid!(12));
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    if let Err(e) = conn.execute(
        r#"INSERT OR IGNORE INTO files (id, blob_hash, file_name, original_path, size, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, '', 0, 'image', ?4, '[]', 0, 'active', ?5, ?6)"#,
        rusqlite::params![file_id, blob_hash, file_name, mime, now, now],
    ) {
        log::warn!(
            "[QuestionImport] ensure_vfs_file: 创建 file 条目失败: {}",
            e
        );
        return None;
    }

    Some(file_id)
}

/// 导入完成后，从 questions 表回填 preview.pages[0].cards，
/// 使前端 `generateImportSummary` 能读到正确的题目数和内容。
/// 仅用于 DOCX VLM 直提 / 纯文本 等不经过 Visual-First 管线的导入路径。
fn rebuild_preview_from_questions(vfs_db: &VfsDatabase, session_id: &str) {
    // 读取所有已保存题目
    let questions = match VfsQuestionRepo::list_questions(
        vfs_db,
        session_id,
        &QuestionFilters::default(),
        1,
        10000, // 足够大，一次拿完
    ) {
        Ok(result) => result.questions,
        Err(e) => {
            log::warn!(
                "[QuestionImport] rebuild_preview: 读取题目失败: {}",
                e
            );
            return;
        }
    };

    if questions.is_empty() {
        return;
    }

    // 构建 ExamCardPreview 列表
    let cards: Vec<ExamCardPreview> = questions
        .iter()
        .enumerate()
        .map(|(idx, q)| {
            ExamCardPreview {
                card_id: q.card_id.clone().unwrap_or_else(|| format!("card_{}", idx)),
                page_index: 0,
                question_label: q
                    .question_label
                    .clone()
                    .unwrap_or_else(|| format!("{}", idx + 1)),
                ocr_text: q.content.clone(),
                tags: q.tags.clone(),
                question_type: serde_json::to_value(&q.question_type).ok()
                    .and_then(|v| serde_json::from_value(v).ok()),
                answer: q.answer.clone(),
                explanation: q.explanation.clone(),
                difficulty: q.difficulty.as_ref().and_then(|d|
                    serde_json::to_value(d).ok().and_then(|v| serde_json::from_value(v).ok())
                ),
                status: serde_json::to_value(&q.status).ok()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default(),
                source_type: serde_json::to_value(&q.source_type).ok()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default(),
                ..Default::default()
            }
        })
        .collect();

    let page = ExamSheetPreviewPage {
        page_index: 0,
        blob_hash: None,
        width: None,
        height: None,
        original_image_path: String::new(),
        cards,
        raw_ocr_text: None,
        ocr_completed: false,
        parse_completed: false,
    };

    let preview = ExamSheetPreviewResult {
        temp_id: String::new(),
        exam_name: None,
        pages: vec![page],
        raw_model_response: None,
        instructions: None,
        session_id: Some(session_id.to_string()),
    };

    match serde_json::to_value(&preview) {
        Ok(preview_json) => {
            if let Err(e) =
                VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
            {
                log::warn!(
                    "[QuestionImport] rebuild_preview: 更新 preview 失败: {}",
                    e
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[QuestionImport] rebuild_preview: 序列化失败: {}",
                e
            );
        }
    }
}

// ============================================================================
// CSV 导入功能（保持不变）
// ============================================================================

/// CSV 导入去重策略
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CsvDuplicateStrategy {
    #[default]
    Skip,
    Overwrite,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportRequest {
    pub file_path: String,
    pub exam_id: String,
    pub field_mapping: HashMap<String, String>,
    #[serde(default)]
    pub duplicate_strategy: CsvDuplicateStrategy,
    pub folder_id: Option<String>,
    pub exam_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportResult {
    pub success_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub errors: Vec<CsvImportError>,
    pub exam_id: String,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportError {
    pub row: usize,
    pub message: String,
    pub raw_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CsvImportProgress {
    Started {
        total_rows: usize,
        file_path: String,
        exam_id: String,
    },
    Progress {
        current: usize,
        total: usize,
        success: usize,
        skipped: usize,
        failed: usize,
        exam_id: String,
    },
    Completed(CsvImportResult),
    Failed {
        error: String,
        exam_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvPreviewResult {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub encoding: String,
}

pub struct CsvImportService;

impl CsvImportService {
    pub fn preview_csv(file_path: &str, preview_rows: usize) -> Result<CsvPreviewResult, AppError> {
        let (content, encoding) = Self::read_file_with_encoding(file_path)?;
        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .has_headers(true)
            .from_reader(content.as_bytes());

        let headers: Vec<String> = reader
            .headers()
            .map_err(|e| AppError::validation(format!("读取 CSV 表头失败: {}", e)))?
            .iter()
            .map(|h| h.to_string())
            .collect();

        let mut rows = Vec::new();
        let mut total_rows = 0;
        for result in reader.records() {
            total_rows += 1;
            if rows.len() < preview_rows {
                if let Ok(record) = result {
                    rows.push(record.iter().map(|s| s.to_string()).collect());
                }
            }
        }

        Ok(CsvPreviewResult { headers, rows, total_rows, encoding })
    }

    pub fn import_csv(
        vfs_db: &VfsDatabase,
        request: &CsvImportRequest,
        progress_tx: Option<UnboundedSender<CsvImportProgress>>,
    ) -> Result<CsvImportResult, AppError> {
        log::info!("[CsvImport] 开始导入: {} -> exam_id={}", request.file_path, request.exam_id);

        let (content, encoding) = Self::read_file_with_encoding(&request.file_path)?;
        log::info!("[CsvImport] 编码: {}", encoding);

        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .has_headers(true)
            .from_reader(content.as_bytes());

        let headers: Vec<String> = reader
            .headers()
            .map_err(|e| AppError::validation(format!("读取 CSV 表头失败: {}", e)))?
            .iter()
            .map(|h| h.to_string())
            .collect();

        Self::validate_field_mapping(&headers, &request.field_mapping)?;
        let exam_id = Self::ensure_exam_exists(vfs_db, request)?;
        let mut existing_hashes = Self::get_existing_content_hashes(vfs_db, &exam_id)?;

        let records: Vec<_> = reader.records().collect();
        let total_rows = records.len();

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(CsvImportProgress::Started {
                total_rows,
                file_path: request.file_path.clone(),
                exam_id: exam_id.clone(),
            });
        }

        let mut success_count = 0;
        let mut skipped_count = 0;
        let mut failed_count = 0;
        let mut errors = Vec::new();

        for (idx, result) in records.into_iter().enumerate() {
            let row_num = idx + 2;
            match result {
                Ok(record) => {
                    match Self::process_csv_row(
                        vfs_db, &exam_id, &headers, &record, &request.field_mapping,
                        &request.duplicate_strategy, &mut existing_hashes, row_num,
                    ) {
                        Ok(CsvRowResult::Success) => success_count += 1,
                        Ok(CsvRowResult::Skipped) => skipped_count += 1,
                        Ok(CsvRowResult::Updated) => success_count += 1,
                        Err(e) => {
                            failed_count += 1;
                            errors.push(CsvImportError {
                                row: row_num,
                                message: e.to_string(),
                                raw_data: Some(record.iter().collect::<Vec<_>>().join(",")),
                            });
                        }
                    }
                }
                Err(e) => {
                    failed_count += 1;
                    errors.push(CsvImportError {
                        row: row_num,
                        message: format!("解析行失败: {}", e),
                        raw_data: None,
                    });
                }
            }

            if let Some(ref tx) = progress_tx {
                if (idx + 1) % 10 == 0 || idx + 1 == total_rows {
                    let _ = tx.send(CsvImportProgress::Progress {
                        current: idx + 1,
                        total: total_rows,
                        success: success_count,
                        skipped: skipped_count,
                        failed: failed_count,
                        exam_id: exam_id.clone(),
                    });
                }
            }
        }

        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &exam_id) {
            log::warn!("[CsvImport] 统计刷新失败: {}", e);
        }

        let result = CsvImportResult {
            success_count, skipped_count, failed_count, errors, exam_id, total_rows,
        };

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(CsvImportProgress::Completed(result.clone()));
        }

        Ok(result)
    }

    fn validate_file_path(path: &str) -> Result<(), AppError> {
        if std::path::Path::new(path).to_string_lossy().contains("..") {
            return Err(AppError::validation("路径不允许包含 '..' 目录遍历"));
        }
        Ok(())
    }

    fn read_file_with_encoding(file_path: &str) -> Result<(String, String), AppError> {
        Self::validate_file_path(file_path)?;
        let file = std::fs::File::open(file_path)
            .map_err(|e| AppError::internal(format!("打开文件失败: {}", e)))?;
        let mut reader = BufReader::new(file);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)
            .map_err(|e| AppError::internal(format!("读取文件失败: {}", e)))?;

        if let Ok(content) = String::from_utf8(bytes.clone()) {
            let content = if content.starts_with('\u{FEFF}') { content[3..].to_string() } else { content };
            return Ok((content, "UTF-8".to_string()));
        }
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(&bytes);
        if !had_errors {
            return Ok((decoded.to_string(), "GBK".to_string()));
        }
        let (decoded, _, _) = encoding_rs::GB18030.decode(&bytes);
        Ok((decoded.to_string(), "GB18030".to_string()))
    }

    fn validate_field_mapping(headers: &[String], field_mapping: &HashMap<String, String>) -> Result<(), AppError> {
        if !field_mapping.values().any(|v| v == "content") {
            return Err(AppError::validation("字段映射中必须包含 content 字段"));
        }
        for csv_col in field_mapping.keys() {
            if !headers.contains(csv_col) {
                return Err(AppError::validation(format!("CSV 文件中不存在列 '{}'", csv_col)));
            }
        }
        Ok(())
    }

    fn ensure_exam_exists(vfs_db: &VfsDatabase, request: &CsvImportRequest) -> Result<String, AppError> {
        if let Ok(Some(_)) = VfsExamRepo::get_exam_sheet(vfs_db, &request.exam_id) {
            return Ok(request.exam_id.clone());
        }

        let exam_name = request.exam_name.clone().unwrap_or_else(|| {
            let file_name = std::path::Path::new(&request.file_path)
                .file_stem().and_then(|s| s.to_str()).unwrap_or("CSV导入");
            format!("CSV导入 - {}", file_name)
        });

        let preview = ExamSheetPreviewResult {
            temp_id: request.exam_id.clone(),
            exam_name: Some(exam_name.clone()),
            pages: vec![ExamSheetPreviewPage {
                page_index: 0, cards: Vec::new(), blob_hash: None, width: None, height: None,
                original_image_path: String::new(), raw_ocr_text: None, ocr_completed: false, parse_completed: false,
            }],
            raw_model_response: None, instructions: None, session_id: Some(request.exam_id.clone()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        let params = VfsCreateExamSheetParams {
            exam_name: Some(exam_name), temp_id: request.exam_id.clone(),
            metadata_json: json!({}), preview_json, status: "completed".to_string(),
            folder_id: request.folder_id.clone(),
        };

        VfsExamRepo::create_exam_sheet(vfs_db, params)
            .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
        Ok(request.exam_id.clone())
    }

    fn get_existing_content_hashes(vfs_db: &VfsDatabase, exam_id: &str) -> Result<HashMap<String, String>, AppError> {
        use rusqlite::params;
        let conn = vfs_db.get_conn_safe()
            .map_err(|e| AppError::database(format!("获取连接失败: {}", e)))?;
        let mut stmt = conn.prepare("SELECT id, content FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL")
            .map_err(|e| AppError::database(format!("准备查询失败: {}", e)))?;
        let rows = stmt.query_map(params![exam_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| AppError::database(format!("查询失败: {}", e)))?;

        let mut hashes = HashMap::new();
        for row in rows {
            let (id, content) = row.map_err(|e| AppError::database(format!("读取行失败: {}", e)))?;
            hashes.insert(Self::compute_content_hash(&content), id);
        }
        Ok(hashes)
    }

    fn compute_content_hash(content: &str) -> String {
        let normalized = content.trim().replace([' ', '\t', '\r', '\n'], "");
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        hex::encode(&hasher.finalize()[..16])
    }

    fn process_csv_row(
        vfs_db: &VfsDatabase, exam_id: &str, headers: &[String], record: &csv::StringRecord,
        field_mapping: &HashMap<String, String>, duplicate_strategy: &CsvDuplicateStrategy,
        existing_hashes: &mut HashMap<String, String>, row_num: usize,
    ) -> Result<CsvRowResult, AppError> {
        let mut field_values: HashMap<String, String> = HashMap::new();
        for (csv_col, target_field) in field_mapping {
            if let Some(col_idx) = headers.iter().position(|h| h == csv_col) {
                if let Some(value) = record.get(col_idx) {
                    if !value.trim().is_empty() {
                        field_values.insert(target_field.clone(), value.to_string());
                    }
                }
            }
        }

        let content = field_values.get("content")
            .ok_or_else(|| AppError::validation(format!("第 {} 行: content 为空", row_num)))?;
        if content.trim().is_empty() {
            return Err(AppError::validation(format!("第 {} 行: content 为空", row_num)));
        }

        let content_hash = Self::compute_content_hash(content);
        if let Some(existing_id) = existing_hashes.get(&content_hash) {
            match duplicate_strategy {
                CsvDuplicateStrategy::Skip => return Ok(CsvRowResult::Skipped),
                CsvDuplicateStrategy::Overwrite => {
                    let params = Self::build_update_params(&field_values);
                    VfsQuestionRepo::update_question(vfs_db, existing_id, &params)
                        .map_err(|e| AppError::database(format!("更新失败: {}", e)))?;
                    return Ok(CsvRowResult::Updated);
                }
                CsvDuplicateStrategy::Merge => {
                    if let Ok(Some(existing)) = VfsQuestionRepo::get_question(vfs_db, existing_id) {
                        let params = Self::build_merge_params(&field_values, &existing);
                        VfsQuestionRepo::update_question(vfs_db, existing_id, &params)
                            .map_err(|e| AppError::database(format!("合并失败: {}", e)))?;
                        return Ok(CsvRowResult::Updated);
                    }
                }
            }
        }

        let params = Self::build_create_params(exam_id, &field_values, row_num);
        let new_q = VfsQuestionRepo::create_question(vfs_db, &params)
            .map_err(|e| AppError::database(format!("创建失败: {}", e)))?;
        existing_hashes.insert(content_hash, new_q.id);
        Ok(CsvRowResult::Success)
    }

    fn build_create_params(exam_id: &str, fv: &HashMap<String, String>, row_num: usize) -> CreateQuestionParams {
        CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(format!("csv_{}", nanoid::nanoid!(10))),
            question_label: fv.get("question_label").cloned().or_else(|| Some(format!("Q{}", row_num - 1))),
            content: fv.get("content").cloned().unwrap_or_default(),
            options: fv.get("options").and_then(|s| Self::parse_options_string(s)),
            answer: fv.get("answer").cloned(),
            explanation: fv.get("explanation").cloned(),
            question_type: fv.get("question_type").and_then(|t| Self::parse_question_type(t)),
            difficulty: fv.get("difficulty").and_then(|d| Self::parse_difficulty(d)),
            tags: fv.get("tags").and_then(|t| Self::parse_tags(t)),
            source_type: Some(crate::vfs::repos::SourceType::Imported),
            source_ref: Some("csv".to_string()),
            images: None,
            parent_id: None,
        }
    }

    fn build_update_params(fv: &HashMap<String, String>) -> crate::vfs::repos::UpdateQuestionParams {
        let mut params = crate::vfs::repos::UpdateQuestionParams::default();
        if let Some(v) = fv.get("content") { params.content = Some(v.clone()); }
        if let Some(v) = fv.get("answer") { params.answer = Some(v.clone()); }
        if let Some(v) = fv.get("explanation") { params.explanation = Some(v.clone()); }
        if let Some(v) = fv.get("options") { params.options = Self::parse_options_string(v); }
        if let Some(v) = fv.get("question_type") { params.question_type = Self::parse_question_type(v); }
        if let Some(v) = fv.get("difficulty") { params.difficulty = Self::parse_difficulty(v); }
        if let Some(v) = fv.get("tags") { params.tags = Self::parse_tags(v); }
        params
    }

    fn build_merge_params(fv: &HashMap<String, String>, existing: &crate::vfs::repos::Question) -> crate::vfs::repos::UpdateQuestionParams {
        let mut params = crate::vfs::repos::UpdateQuestionParams::default();
        if existing.answer.is_none() { if let Some(v) = fv.get("answer") { params.answer = Some(v.clone()); } }
        if existing.explanation.is_none() { if let Some(v) = fv.get("explanation") { params.explanation = Some(v.clone()); } }
        if existing.options.is_none() { if let Some(v) = fv.get("options") { params.options = Self::parse_options_string(v); } }
        if existing.tags.is_empty() { if let Some(v) = fv.get("tags") { params.tags = Self::parse_tags(v); } }
        params
    }

    fn parse_options_string(s: &str) -> Option<Vec<crate::vfs::repos::QuestionOption>> {
        let s = s.trim();
        if s.starts_with('[') {
            if let Ok(opts) = serde_json::from_str::<Vec<crate::vfs::repos::QuestionOption>>(s) {
                return Some(opts);
            }
        }
        for sep in [';', '\n', '|'] {
            let parts: Vec<&str> = s.split(sep).filter(|p| !p.trim().is_empty()).collect();
            if parts.len() >= 2 {
                let options: Vec<_> = parts.iter().filter_map(|part| {
                    let part = part.trim();
                    let re = regex::Regex::new(r"^([A-Za-z])[\.、\s]\s*(.+)$").ok()?;
                    let caps = re.captures(part)?;
                    Some(crate::vfs::repos::QuestionOption {
                        key: caps.get(1)?.as_str().to_uppercase(),
                        content: caps.get(2)?.as_str().to_string(),
                    })
                }).collect();
                if !options.is_empty() { return Some(options); }
            }
        }
        None
    }

    fn parse_question_type(s: &str) -> Option<crate::vfs::repos::QuestionType> {
        match s.trim().to_lowercase().as_str() {
            "single_choice" | "单选" | "单选题" => Some(crate::vfs::repos::QuestionType::SingleChoice),
            "multiple_choice" | "多选" | "多选题" => Some(crate::vfs::repos::QuestionType::MultipleChoice),
            "indefinite_choice" | "不定项" => Some(crate::vfs::repos::QuestionType::IndefiniteChoice),
            "fill_blank" | "填空" | "填空题" => Some(crate::vfs::repos::QuestionType::FillBlank),
            "short_answer" | "简答" | "简答题" => Some(crate::vfs::repos::QuestionType::ShortAnswer),
            "essay" | "论述" | "论述题" => Some(crate::vfs::repos::QuestionType::Essay),
            "calculation" | "计算" | "计算题" => Some(crate::vfs::repos::QuestionType::Calculation),
            "proof" | "证明" | "证明题" => Some(crate::vfs::repos::QuestionType::Proof),
            _ => Some(crate::vfs::repos::QuestionType::Other),
        }
    }

    fn parse_difficulty(s: &str) -> Option<crate::vfs::repos::Difficulty> {
        match s.trim().to_lowercase().as_str() {
            "easy" | "简单" | "1" => Some(crate::vfs::repos::Difficulty::Easy),
            "medium" | "中等" | "2" => Some(crate::vfs::repos::Difficulty::Medium),
            "hard" | "困难" | "难" | "3" => Some(crate::vfs::repos::Difficulty::Hard),
            "very_hard" | "极难" | "4" => Some(crate::vfs::repos::Difficulty::VeryHard),
            _ => None,
        }
    }

    fn parse_tags(s: &str) -> Option<Vec<String>> {
        let s = s.trim();
        if s.starts_with('[') {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(s) { return Some(tags); }
        }
        for sep in [',', ';', '|', '、'] {
            if s.contains(sep) {
                let tags: Vec<String> = s.split(sep).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
                if !tags.is_empty() { return Some(tags); }
            }
        }
        if !s.is_empty() { Some(vec![s.to_string()]) } else { None }
    }
}

enum CsvRowResult {
    Success,
    Skipped,
    Updated,
}
