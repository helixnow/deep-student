//! 题目导入服务 - 统一的文档解析和题目导入逻辑
//!
//! 此模块提供统一的题目导入实现，供以下调用方使用：
//! - Tauri 命令：`import_question_bank`
//! - Tauri 命令：`import_question_bank_stream`（流式版本）
//! - Tauri 命令：`import_questions_csv`（CSV 导入）
//! - MCP 工具：`qbank_import_document`
//! - 前端：`ExamSheetUploader`
//!
//! ## 设计原则
//! 仿照 Anki Agent 的 `DocumentProcessingService`：
//! 1. 分块策略统一（max 6000 tokens/chunk）
//! 2. 每块独立 LLM 解析
//! 3. 合并去重
//! 4. 单块失败不中断整体
//!
//! ## CSV 导入功能
//! - 支持 UTF-8 和 GBK 编码自动检测
//! - 字段映射：用户可指定 CSV 列与题目字段的对应关系
//! - 去重策略：skip（跳过）/ overwrite（覆盖）/ merge（合并）
//! - 流式处理大文件，不因单行错误中断

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

use crate::document_parser::DocumentParser;
use crate::file_manager::FileManager;
use crate::llm_manager::LLMManager;
use crate::models::{
    AppError, Difficulty, ExamCardPreview, ExamSheetPreviewPage, ExamSheetPreviewResult,
    ExamSheetSessionDetail, QuestionStatus, QuestionType, SourceType,
};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{CreateQuestionParams, QuestionFilters, VfsExamRepo, VfsQuestionRepo};
use crate::vfs::types::VfsCreateExamSheetParams;

/// 流式导入进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum QuestionImportProgress {
    SessionCreated {
        session_id: String,
        name: String,
        total_chunks: usize,
    },
    ChunkStart {
        chunk_index: usize,
        total_chunks: usize,
    },
    QuestionParsed {
        question: Value,
        question_index: usize,
        total_parsed: usize,
    },
    ChunkCompleted {
        chunk_index: usize,
        total_chunks: usize,
        questions_in_chunk: usize,
        total_parsed: usize,
    },
    Completed {
        session_id: String,
        name: String,
        total_questions: usize,
    },
    Failed {
        session_id: Option<String>,
        error: String,
        total_parsed: usize,
    },
}

/// 题目导入服务
pub struct QuestionImportService {
    llm_manager: Arc<LLMManager>,
    file_manager: Option<Arc<FileManager>>,
}

/// 导入请求参数
#[derive(Debug, Clone)]
pub struct ImportRequest {
    pub content: String,
    pub format: String,
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub folder_id: Option<String>,
    pub model_config_id: Option<String>,
}

/// 导入结果
#[derive(Debug, Clone)]
pub struct ImportResult {
    pub session_id: String,
    pub name: String,
    pub imported_count: usize,
    pub total_questions: usize,
}

impl QuestionImportService {
    pub fn new(llm_manager: Arc<LLMManager>, file_manager: Arc<FileManager>) -> Self {
        Self { llm_manager, file_manager: Some(file_manager) }
    }

    /// 不带 file_manager 的构造（MCP 工具等不需要图片 OCR 的场景）
    pub fn new_without_file_manager(llm_manager: Arc<LLMManager>) -> Self {
        Self { llm_manager, file_manager: None }
    }

    /// 判断格式是否为图片
    fn is_image_format(format: &str) -> bool {
        matches!(format, "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff" | "image")
    }

    /// OCR 图片（base64）→ 纯文本
    /// 支持单张图片（裸 base64）或多张图片（JSON 数组 ["base64_1", "base64_2"]）
    async fn ocr_images_to_text(&self, content: &str) -> Result<String, AppError> {
        use base64::Engine;

        // 解析输入：可能是 JSON 数组或单个 base64 字符串
        let base64_images: Vec<String> = if content.trim_start().starts_with('[') {
            serde_json::from_str(content)
                .map_err(|e| AppError::validation(format!("解析图片列表失败: {}", e)))?
        } else {
            vec![content.to_string()]
        };

        if base64_images.is_empty() {
            return Err(AppError::validation("图片列表为空"));
        }

        let fm = self.file_manager.as_ref()
            .ok_or_else(|| AppError::validation("图片导入需要 FileManager，当前上下文不支持"))?;
        let temp_dir = fm.get_writable_app_data_dir().join("temp_ocr_import");
        tokio::fs::create_dir_all(&temp_dir).await
            .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

        let mut all_texts = Vec::new();

        for (i, b64) in base64_images.iter().enumerate() {
            // 去除可能的 data URL 前缀
            let raw_b64 = if let Some(pos) = b64.find(",") {
                &b64[pos + 1..]
            } else {
                b64.as_str()
            };

            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw_b64)
                .map_err(|e| AppError::validation(format!("图片 {} base64 解码失败: {}", i + 1, e)))?;

            // 写入临时文件
            let temp_path = temp_dir.join(format!("page_{}.png", i));
            tokio::fs::write(&temp_path, &bytes).await
                .map_err(|e| AppError::file_system(format!("写入临时图片失败: {}", e)))?;

            log::info!("[QuestionImport] OCR 图片 {}/{}: {}", i + 1, base64_images.len(), temp_path.display());

            // 调用视觉模型做纯文本 OCR（FreeOcr 模式，不带坐标标记）
            match self.llm_manager.convert_image_to_markdown(
                temp_path.to_str().unwrap_or_default(),
            ).await {
                Ok(text) => {
                    log::info!("[QuestionImport] 图片 {} OCR 成功: {} 字符", i + 1, text.len());
                    all_texts.push(text);
                }
                Err(e) => {
                    log::warn!("[QuestionImport] 图片 {} OCR 失败: {}", i + 1, e);
                }
            }
        }

        // 清理临时目录
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;

        if all_texts.is_empty() {
            return Err(AppError::validation("所有图片 OCR 均失败，请检查图片清晰度"));
        }

        Ok(all_texts.join("\n\n"))
    }

    /// 统一的文档导入入口
    pub async fn import_document(
        &self,
        vfs_db: &VfsDatabase,
        request: ImportRequest,
    ) -> Result<ImportResult, AppError> {
        // 1. 提取文本内容
        // 注意：前端对所有文件都使用 base64 编码
        let text_content = match request.format.as_str() {
            "json" => {
                // JSON 格式直接解析，不需要 LLM
                return self.import_json_directly(vfs_db, &request).await;
            }
            "txt" | "md" | "markdown" => {
                // 文本文件：优先 base64 解码，失败则视为纯文本
                self.decode_text_content(&request.content)
                    .unwrap_or_else(|_| request.content.clone())
            }
            format @ ("docx" | "xlsx" | "xls" | "pdf") => {
                // 使用 DocumentParser 解析复杂格式
                let parser = DocumentParser::new();
                let file_name = format!("document.{}", format);
                parser
                    .extract_text_from_base64(&file_name, &request.content)
                    .map_err(|e| AppError::validation(format!("文档解析失败: {}", e)))?
            }
            fmt if Self::is_image_format(fmt) => {
                // ★ 图片格式：OCR 提取文本，然后走统一解析流程
                self.ocr_images_to_text(&request.content).await?
            }
            _ => {
                // 其他格式：尝试作为 base64 解码，失败则作为纯文本
                self.decode_text_content(&request.content)
                    .unwrap_or_else(|_| request.content.clone())
            }
        };

        if text_content.trim().is_empty() {
            return Err(AppError::validation("文档内容为空"));
        }

        let questions = self
            .parse_document_with_chunking(&text_content, request.model_config_id.as_deref())
            .await?;

        if questions.is_empty() {
            return Err(AppError::validation("未能从文档中解析出题目"));
        }

        self.save_questions_to_session(vfs_db, questions, &request)
            .await
    }

    /// 分块解析文档（核心逻辑，统一实现）
    ///
    /// 仿照 DocumentProcessingService 的策略：
    /// - 估算 token 数（2 字符 ≈ 1 token）
    /// - 超过 6000 tokens 则分块
    /// - 每块独立 LLM 解析
    /// - 合并结果
    async fn parse_document_with_chunking(
        &self,
        text_content: &str,
        model_config_id: Option<&str>,
    ) -> Result<Vec<Value>, AppError> {
        let max_tokens_per_chunk = 6000;
        let estimated_tokens = text_content.chars().count() / 2;

        log::info!(
            "[QuestionImport] 文档长度: {} 字符, 估计 {} tokens",
            text_content.len(),
            estimated_tokens
        );

        if estimated_tokens <= max_tokens_per_chunk {
            return self.parse_single_chunk(text_content, model_config_id).await;
        }

        let chunks = self.segment_document(text_content, max_tokens_per_chunk);
        log::info!("[QuestionImport] 超长文档，分割为 {} 个块", chunks.len());

        let mut all_questions = Vec::new();
        for (i, chunk) in chunks.iter().enumerate() {
            log::info!(
                "[QuestionImport] 处理块 {}/{} ({} 字符)",
                i + 1,
                chunks.len(),
                chunk.len()
            );

            match self.parse_single_chunk(chunk, model_config_id).await {
                Ok(questions) => {
                    log::info!(
                        "[QuestionImport] 块 {} 解析出 {} 道题目",
                        i + 1,
                        questions.len()
                    );
                    all_questions.extend(questions);
                }
                Err(e) => {
                    log::warn!("[QuestionImport] 块 {} 解析失败: {}", i + 1, e);
                }
            }
        }

        if all_questions.is_empty() {
            return Err(AppError::validation("所有块解析均失败，未能提取到题目"));
        }

        log::info!("[QuestionImport] 总计解析出 {} 道题目", all_questions.len());
        Ok(all_questions)
    }

    /// 分割文档为多个块（统一实现，仿照 DocumentProcessingService）
    fn segment_document(&self, content: &str, max_tokens: usize) -> Vec<String> {
        // 按双换行分割段落
        let paragraphs: Vec<&str> = content
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .collect();

        // 如果段落太少，按单换行分割
        let paragraphs: Vec<&str> = if paragraphs.len() < 3 {
            content
                .split('\n')
                .filter(|p| !p.trim().is_empty())
                .collect()
        } else {
            paragraphs
        };

        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut current_tokens = 0;

        for para in paragraphs {
            let para_tokens = para.chars().count() / 2;

            // 如果单个段落就超过限制，需要强制分割
            if para_tokens > max_tokens {
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.trim().to_string());
                    current_chunk.clear();
                    current_tokens = 0;
                }

                // 按字符强制分割长段落
                let char_limit = max_tokens * 2;
                let chars: Vec<char> = para.chars().collect();
                for chunk_chars in chars.chunks(char_limit) {
                    let sub_chunk: String = chunk_chars.iter().collect();
                    chunks.push(sub_chunk);
                }
                continue;
            }

            // 检查添加这个段落是否会超出限制
            if current_tokens + para_tokens > max_tokens && !current_chunk.is_empty() {
                // 保存当前块并开始新块
                chunks.push(current_chunk.trim().to_string());
                current_chunk = para.to_string();
                current_tokens = para_tokens;
            } else {
                // 添加到当前块
                if !current_chunk.is_empty() {
                    current_chunk.push_str("\n\n");
                }
                current_chunk.push_str(para);
                current_tokens += para_tokens;
            }
        }

        // 添加最后一个块
        if !current_chunk.is_empty() {
            chunks.push(current_chunk.trim().to_string());
        }

        chunks
    }

    /// 解析单个文本块
    /// 构建题目解析的 prompt
    fn build_parse_prompt(&self, chunk: &str) -> String {
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
      {{"key": "B", "content": "选项B内容"}},
      {{"key": "C", "content": "选项C内容"}},
      {{"key": "D", "content": "选项D内容"}}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }}
]
```

**解析规则**：
1. 识别所有题目，包括选择题、填空题、简答题、计算题等
2. **选择题必须**：将选项拆分到 options 数组，content 只保留题干
3. 题型判断：
   - single_choice: 单选题（只能选一个）
   - multiple_choice: 多选题（答案明确是多个，如"选AB"）
   - indefinite_choice: 不定项选择题（选项数量不定）
4. options 支持任意数量选项（A-Z），非选择题可省略
5. answer 格式：单选填字母如"A"，多选填多个字母如"AB"或"A,B"
6. difficulty 默认为 "medium"
7. tags 根据题目知识点自动生成

**LaTeX 格式化（极其重要）**：
- 所有数学公式、变量、符号必须用 LaTeX 格式输出
- 行内公式用 $...$ 包裹，例如：$E_{{p}} = -\frac{{GMm}}{{r}}$
- 独立公式（单独成行的长公式）用 $$...$$ 包裹
- 下标用 $r_{{1}}$，上标用 $v^{{2}}$，分数用 $\frac{{a}}{{b}}$，根号用 $\sqrt{{x}}$
- 希腊字母用 $\alpha$, $\beta$, $\pi$ 等
- 度数符号用 $90^\circ$
- 中文文本保持原样，只对数学部分添加 LaTeX 标记"#,
            chunk
        )
    }

    /// 流式解析单个文本块 - 每解析出一道题目立即回调
    async fn parse_single_chunk_streaming<F>(
        &self,
        chunk: &str,
        model_config_id: Option<&str>,
        on_question: F,
    ) -> Result<Vec<Value>, AppError>
    where
        F: FnMut(Value) -> bool + Send,
    {
        let prompt = self.build_parse_prompt(chunk);

        self.llm_manager
            .call_llm_for_question_parsing_streaming(&prompt, model_config_id, on_question)
            .await
            .map_err(|e| AppError::validation(format!("LLM 流式调用失败: {}", e)))
    }

    /// 非流式解析单个文本块（保留用于兼容）
    #[allow(dead_code)]
    async fn parse_single_chunk(
        &self,
        chunk: &str,
        model_config_id: Option<&str>,
    ) -> Result<Vec<Value>, AppError> {
        let prompt = self.build_parse_prompt(chunk);

        let response = self
            .llm_manager
            .call_llm_for_question_parsing_with_model(&prompt, model_config_id)
            .await
            .map_err(|e| AppError::validation(format!("LLM 调用失败: {}", e)))?;

        // 从响应中提取 JSON
        let json_str = if let Some(start) = response.find('[') {
            if let Some(end) = response.rfind(']') {
                &response[start..=end]
            } else {
                return Err(AppError::validation(
                    "LLM 响应格式错误：未找到有效 JSON 数组",
                ));
            }
        } else {
            return Err(AppError::validation("LLM 响应格式错误：未找到题目列表"));
        };

        let questions: Vec<Value> = serde_json::from_str(json_str)
            .map_err(|e| AppError::validation(format!("解析 LLM 响应失败: {}", e)))?;

        Ok(questions)
    }

    /// 从 base64 解码文本文件内容（txt, md 等）
    fn decode_text_content(&self, base64_content: &str) -> Result<String, AppError> {
        use base64::Engine;

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))?;

        // 尝试 UTF-8 解码
        String::from_utf8(bytes).map_err(|e| {
            AppError::validation(format!("文件编码错误，请确保文件使用 UTF-8 编码: {}", e))
        })
    }

    /// 直接导入 JSON 格式
    async fn import_json_directly(
        &self,
        vfs_db: &VfsDatabase,
        request: &ImportRequest,
    ) -> Result<ImportResult, AppError> {
        // 尝试从 base64 解码，失败则假设是纯文本
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

        self.save_questions_to_session(vfs_db, questions, request)
            .await
    }

    /// 保存题目到会话
    async fn save_questions_to_session(
        &self,
        vfs_db: &VfsDatabase,
        questions: Vec<Value>,
        request: &ImportRequest,
    ) -> Result<ImportResult, AppError> {
        // 如果有 session_id，追加到现有题目集
        if let Some(sid) = &request.session_id {
            return self
                .append_to_existing_session(vfs_db, questions, sid)
                .await;
        }

        // 创建新题目集
        self.create_new_session(vfs_db, questions, request).await
    }

    /// 追加到现有题目集
    ///
    /// ★ M-037 修复：使用 SAVEPOINT 事务保护，确保 update_preview_json 和
    /// create_question 多步操作的原子性。避免 preview_json 已更新但题目写入失败
    /// 导致数据不一致。
    async fn append_to_existing_session(
        &self,
        vfs_db: &VfsDatabase,
        questions: Vec<Value>,
        session_id: &str,
    ) -> Result<ImportResult, AppError> {
        // 1. 获取连接（在 SAVEPOINT 外，减少事务持有时间）
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let exam = VfsExamRepo::get_exam_sheet_with_conn(&conn, session_id)
            .map_err(|e| AppError::database(format!("获取题目集失败: {}", e)))?
            .ok_or_else(|| AppError::not_found("题目集不存在"))?;

        let exam_name = exam
            .exam_name
            .clone()
            .unwrap_or_else(|| "未命名".to_string());

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| AppError::validation(format!("解析 preview 失败: {}", e)))?;

        // 2. 纯计算：构建 cards 和 question_params（在 SAVEPOINT 外）
        let mut imported_count = 0;
        let mut question_params_list = Vec::new();

        for q in &questions {
            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                continue;
            }

            let card = self.question_to_card(q, imported_count);
            let card_id = card.card_id.clone();

            if preview.pages.is_empty() {
                preview.pages.push(ExamSheetPreviewPage {
                    page_index: 0,
                    cards: Vec::new(),
                    blob_hash: None,
                    width: None,
                    height: None,
                    original_image_path: String::new(),
                    raw_ocr_text: None,
                    ocr_completed: false,
                    parse_completed: false,
                });
            }
            preview.pages[0].cards.push(card);

            question_params_list.push(self.json_to_question_params(
                q,
                session_id,
                &card_id,
                imported_count,
            ));
            imported_count += 1;
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        // 3. ★ SAVEPOINT 事务保护：包裹 update_preview_json + create_questions 两步操作
        //    不使用 batch_create_questions_with_conn 因为它内部会启动自己的 BEGIN IMMEDIATE，
        //    与 SAVEPOINT 冲突。改为直接循环调用 create_question_with_conn。
        conn.execute("SAVEPOINT append_session", []).map_err(|e| {
            log::error!(
                "[QuestionImport] Failed to create savepoint for append_session: {}",
                e
            );
            AppError::database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> Result<(), AppError> {
            // 3a. 更新 preview_json
            VfsExamRepo::update_preview_json_with_conn(&conn, session_id, preview_json)
                .map_err(|e| AppError::database(format!("更新题目集失败: {}", e)))?;

            // 3b. 逐条写入 questions 表（权威数据源）
            for params in &question_params_list {
                VfsQuestionRepo::create_question_with_conn(&conn, params)
                    .map_err(|e| AppError::database(format!("写入题目表失败: {}", e)))?;
            }

            Ok(())
        })();

        match result {
            Ok(()) => {
                conn.execute("RELEASE append_session", []).map_err(|e| {
                    log::error!(
                        "[QuestionImport] Failed to release savepoint append_session: {}",
                        e
                    );
                    AppError::database(format!("Failed to release savepoint: {}", e))
                })?;
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO append_session", []);
                let _ = conn.execute("RELEASE append_session", []);
                log::warn!("[QuestionImport] append_session rolled back: {}", e);
                return Err(e);
            }
        }

        // 4. 刷新统计（非关键，在 SAVEPOINT 外执行）
        if !question_params_list.is_empty() {
            if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&conn, session_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        let total = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
        Ok(ImportResult {
            session_id: session_id.to_string(),
            name: exam_name,
            imported_count,
            total_questions: total,
        })
    }

    /// 创建新题目集
    ///
    /// S-009 fix: 使用 SAVEPOINT 事务保护，确保 create_exam_sheet + questions 写入
    /// 的原子性。与 append_to_existing_session 保持一致的 SAVEPOINT 模式。
    async fn create_new_session(
        &self,
        vfs_db: &VfsDatabase,
        questions: Vec<Value>,
        request: &ImportRequest,
    ) -> Result<ImportResult, AppError> {
        let temp_id = uuid::Uuid::new_v4().to_string();
        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        // 1. 纯计算：构建 cards 并收集有效题目及其 card_id（在 SAVEPOINT 外）
        let mut cards = Vec::new();
        let mut valid_questions: Vec<(usize, &Value, String)> = Vec::new();

        for (i, q) in questions.iter().enumerate() {
            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                continue;
            }
            let card = self.question_to_card(q, i);
            let card_id = card.card_id.clone();
            cards.push(card);
            valid_questions.push((i, q, card_id));
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

        // 2. 获取连接（在 SAVEPOINT 外，减少事务持有时间）
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        // 3. ★ SAVEPOINT 事务保护：包裹 create_exam_sheet + create_questions 两步操作
        //    不使用 batch_create_questions_with_conn 因为它内部会启动自己的 BEGIN IMMEDIATE，
        //    与 SAVEPOINT 冲突。改为直接循环调用 create_question_with_conn。
        conn.execute("SAVEPOINT create_session", []).map_err(|e| {
            log::error!(
                "[QuestionImport] Failed to create savepoint for create_session: {}",
                e
            );
            AppError::database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> Result<(String, usize), AppError> {
            // 3a. 创建 exam_sheet 记录，获取真实的 exam_id（exam_ + nanoid 格式）
            let create_params = VfsCreateExamSheetParams {
                exam_name: Some(qbank_name.clone()),
                temp_id: temp_id.clone(),
                metadata_json: json!({}),
                preview_json,
                status: "completed".to_string(),
                folder_id: request.folder_id.clone(),
            };

            let exam_sheet = VfsExamRepo::create_exam_sheet_with_conn(&conn, create_params)
                .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
            let real_exam_id = exam_sheet.id;

            // 3b. 使用真实 exam_id 逐条写入 questions 表
            for (i, q, card_id) in &valid_questions {
                let params = self.json_to_question_params(q, &real_exam_id, card_id, *i);
                VfsQuestionRepo::create_question_with_conn(&conn, &params)
                    .map_err(|e| AppError::database(format!("写入题目表失败: {}", e)))?;
            }

            let total = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
            Ok((real_exam_id, total))
        })();

        match result {
            Ok((real_exam_id, total)) => {
                conn.execute("RELEASE create_session", []).map_err(|e| {
                    log::error!(
                        "[QuestionImport] Failed to release savepoint create_session: {}",
                        e
                    );
                    AppError::database(format!("Failed to release savepoint: {}", e))
                })?;

                // 刷新统计（非关键，在 SAVEPOINT 外执行）
                if !valid_questions.is_empty() {
                    if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&conn, &real_exam_id) {
                        log::warn!("[QuestionBank] 统计刷新失败: {}", e);
                    }
                }

                log::info!(
                    "[QuestionImport] S-009: create_new_session SAVEPOINT 提交成功, session={}",
                    real_exam_id
                );
                Ok(ImportResult {
                    session_id: real_exam_id,
                    name: qbank_name,
                    imported_count: total,
                    total_questions: total,
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO create_session", []);
                let _ = conn.execute("RELEASE create_session", []);
                log::warn!(
                    "[QuestionImport] S-009: create_new_session SAVEPOINT 回滚: {}",
                    e
                );
                Err(e)
            }
        }
    }

    /// 将 JSON 题目转换为 CreateQuestionParams（直接写入 questions 表）
    fn json_to_question_params(
        &self,
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

        // 解析选项
        let options = q.get("options").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|opt| {
                    let key = opt
                        .get("key")
                        .and_then(|k| k.as_str())
                        .unwrap_or("")
                        .to_string();
                    let content = opt
                        .get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    if key.is_empty() && content.is_empty() {
                        None
                    } else {
                        Some(crate::vfs::repos::QuestionOption { key, content })
                    }
                })
                .collect()
        });

        // 解析题目类型
        let question_type = q
            .get("question_type")
            .and_then(|v| v.as_str())
            .and_then(|t| match t.to_lowercase().as_str() {
                "single_choice" | "单选" | "单选题" => {
                    Some(crate::vfs::repos::QuestionType::SingleChoice)
                }
                "multiple_choice" | "多选" | "多选题" => {
                    Some(crate::vfs::repos::QuestionType::MultipleChoice)
                }
                "indefinite_choice" | "不定项" | "不定项选择" | "不定项选择题" => {
                    Some(crate::vfs::repos::QuestionType::IndefiniteChoice)
                }
                "fill_blank" | "填空" | "填空题" => {
                    Some(crate::vfs::repos::QuestionType::FillBlank)
                }
                "short_answer" | "简答" | "简答题" => {
                    Some(crate::vfs::repos::QuestionType::ShortAnswer)
                }
                "essay" | "论述" | "论述题" => Some(crate::vfs::repos::QuestionType::Essay),
                "calculation" | "计算" | "计算题" => {
                    Some(crate::vfs::repos::QuestionType::Calculation)
                }
                "proof" | "证明" | "证明题" => Some(crate::vfs::repos::QuestionType::Proof),
                _ => Some(crate::vfs::repos::QuestionType::Other),
            });

        // 解析难度
        let difficulty = q.get("difficulty").and_then(|v| v.as_str()).and_then(|d| {
            match d.to_lowercase().as_str() {
                "easy" | "简单" => Some(crate::vfs::repos::Difficulty::Easy),
                "medium" | "中等" => Some(crate::vfs::repos::Difficulty::Medium),
                "hard" | "困难" => Some(crate::vfs::repos::Difficulty::Hard),
                "very_hard" | "极难" => Some(crate::vfs::repos::Difficulty::VeryHard),
                _ => None,
            }
        });

        // 解析标签
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
            explanation: q
                .get("explanation")
                .and_then(|v| v.as_str())
                .map(String::from),
            question_type,
            difficulty,
            tags,
            source_type: Some(crate::vfs::repos::SourceType::Imported),
            source_ref: None,
            images: None,
            parent_id: None,
        }
    }

    /// 将 JSON 题目转换为 ExamCardPreview
    fn question_to_card(&self, q: &Value, index: usize) -> ExamCardPreview {
        let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let card_id = format!(
            "card_{}",
            uuid::Uuid::new_v4()
                .to_string()
                .replace("-", "")
                .chars()
                .take(12)
                .collect::<String>()
        );

        ExamCardPreview {
            card_id,
            page_index: 0,
            question_label: format!("Q{}", index + 1),
            ocr_text: content.to_string(),
            tags: q
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            question_type: q
                .get("question_type")
                .and_then(|v| v.as_str())
                .and_then(|t| serde_json::from_str(&format!("\"{}\"", t)).ok()),
            answer: q.get("answer").and_then(|v| v.as_str()).map(String::from),
            explanation: q
                .get("explanation")
                .and_then(|v| v.as_str())
                .map(String::from),
            difficulty: q
                .get("difficulty")
                .and_then(|v| v.as_str())
                .and_then(|d| serde_json::from_str(&format!("\"{}\"", d)).ok()),
            status: QuestionStatus::New,
            source_type: SourceType::ImportFile,
            ..Default::default()
        }
    }

    /// 流式导入文档（支持实时进度反馈和中断保存）
    pub async fn import_document_stream(
        &self,
        vfs_db: &VfsDatabase,
        request: ImportRequest,
        progress_tx: Option<UnboundedSender<QuestionImportProgress>>,
    ) -> Result<ImportResult, AppError> {
        let text_content = match request.format.as_str() {
            "json" => {
                return self.import_json_directly(vfs_db, &request).await;
            }
            "txt" | "md" | "markdown" => self.decode_text_content(&request.content)?,
            format @ ("docx" | "xlsx" | "xls" | "pdf") => {
                let parser = DocumentParser::new();
                let file_name = format!("document.{}", format);
                parser
                    .extract_text_from_base64(&file_name, &request.content)
                    .map_err(|e| AppError::validation(format!("文档解析失败: {}", e)))?
            }
            fmt if Self::is_image_format(fmt) => {
                // ★ 图片格式：OCR 提取文本，然后走统一解析流程
                self.ocr_images_to_text(&request.content).await?
            }
            _ => self
                .decode_text_content(&request.content)
                .unwrap_or_else(|_| request.content.clone()),
        };

        if text_content.trim().is_empty() {
            return Err(AppError::validation("文档内容为空"));
        }

        let max_tokens_per_chunk = 6000;
        let estimated_tokens = text_content.chars().count() / 2;
        let chunks = if estimated_tokens <= max_tokens_per_chunk {
            vec![text_content.clone()]
        } else {
            self.segment_document(&text_content, max_tokens_per_chunk)
        };

        let total_chunks = chunks.len();
        let qbank_name = request
            .name
            .clone()
            .unwrap_or_else(|| "导入的题目集".to_string());

        let is_new_session = request.session_id.is_none();

        // 提前创建会话记录（异常中断时已保存的题目不会丢失）
        // S-007 fix: 使用 create_exam_sheet 返回的真实 exam_id，而非 UUID
        let session_id = if let Some(sid) = &request.session_id {
            sid.clone()
        } else {
            let temp_id = uuid::Uuid::new_v4().to_string();
            let empty_preview = ExamSheetPreviewResult {
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
            let preview_json = serde_json::to_value(&empty_preview)
                .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

            let params = VfsCreateExamSheetParams {
                exam_name: Some(qbank_name.clone()),
                temp_id,
                metadata_json: json!({}),
                preview_json,
                status: "importing".to_string(), // 标记为导入中
                folder_id: request.folder_id.clone(),
            };
            let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
                .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
            exam_sheet.id // 使用真实的 exam_id（exam_ + nanoid 格式）
        };

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::SessionCreated {
                session_id: session_id.clone(),
                name: qbank_name.clone(),
                total_chunks,
            });
        }

        let mut all_questions: Vec<Value> = Vec::new();
        let mut total_parsed = 0;

        for (chunk_idx, chunk) in chunks.iter().enumerate() {
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::ChunkStart {
                    chunk_index: chunk_idx,
                    total_chunks,
                });
            }

            // 使用流式解析 - 每解析出一道题目立即发送事件并保存
            let mut questions_in_chunk = 0;
            let chunk_questions = self
                .parse_single_chunk_streaming(
                    chunk,
                    request.model_config_id.as_deref(),
                    |q: Value| {
                        // 立即保存题目到数据库
                        let card = self.question_to_card(&q, total_parsed);
                        let card_id = card.card_id.clone();
                        let params =
                            self.json_to_question_params(&q, &session_id, &card_id, total_parsed);

                        if let Err(e) = VfsQuestionRepo::create_question(vfs_db, &params) {
                            log::warn!("[QuestionImport] 保存题目失败: {}", e);
                        }

                        total_parsed += 1;
                        questions_in_chunk += 1;

                        // 发送 QuestionParsed 事件
                        if let Some(ref tx) = progress_tx {
                            let _ = tx.send(QuestionImportProgress::QuestionParsed {
                                question: q.clone(),
                                question_index: total_parsed - 1,
                                total_parsed,
                            });
                        }

                        true // 继续解析
                    },
                )
                .await;

            match chunk_questions {
                Ok(questions) => {
                    all_questions.extend(questions);

                    if let Some(ref tx) = progress_tx {
                        let _ = tx.send(QuestionImportProgress::ChunkCompleted {
                            chunk_index: chunk_idx,
                            total_chunks,
                            questions_in_chunk,
                            total_parsed,
                        });
                    }
                }
                Err(e) => {
                    log::warn!("[QuestionImport] 块 {} 解析失败: {}", chunk_idx + 1, e);
                    if let Some(ref tx) = progress_tx {
                        let _ = tx.send(QuestionImportProgress::ChunkCompleted {
                            chunk_index: chunk_idx,
                            total_chunks,
                            questions_in_chunk: 0,
                            total_parsed,
                        });
                    }
                }
            }
        }

        // 即使没有解析出题目，如果已创建会话，也更新状态
        if all_questions.is_empty() {
            if is_new_session {
                // 更新状态为 completed（空题目集）
                let _ = VfsExamRepo::update_status(vfs_db, &session_id, "completed");
            }
            if let Some(ref tx) = progress_tx {
                let _ = tx.send(QuestionImportProgress::Failed {
                    session_id: Some(session_id.clone()),
                    error: "所有块解析均失败，未能提取到题目".to_string(),
                    total_parsed: 0,
                });
            }
            return Err(AppError::validation("所有块解析均失败，未能提取到题目"));
        }

        // 最终更新 preview_json 和状态（题目已在上面增量保存）
        let result = self
            .finalize_session(
                vfs_db,
                &all_questions,
                &session_id,
                &qbank_name,
                is_new_session,
            )
            .await?;

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(QuestionImportProgress::Completed {
                session_id: result.session_id.clone(),
                name: result.name.clone(),
                total_questions: result.total_questions,
            });
        }

        Ok(result)
    }

    /// 最终化会话：更新 preview_json 和状态（题目已在增量保存中写入）
    async fn finalize_session(
        &self,
        vfs_db: &VfsDatabase,
        _questions: &[Value],
        session_id: &str,
        qbank_name: &str,
        is_new_session: bool,
    ) -> Result<ImportResult, AppError> {
        // [S-008] 修复：从数据库读取已写入的 questions，使用已有的 card_id 构建 preview_json
        // 之前调用 question_to_card() 会为每道题生成新的 UUID card_id，
        // 导致 preview_json 中的 card_id 与 questions 表中的 card_id 不一致
        let db_result = VfsQuestionRepo::list_questions(
            vfs_db,
            session_id,
            &QuestionFilters::default(),
            1,
            100_000, // 足够大的 page_size 以获取所有题目
        )
        .map_err(|e| AppError::database(format!("查询已保存题目失败: {}", e)))?;

        let cards: Vec<ExamCardPreview> = db_result
            .questions
            .iter()
            .enumerate()
            .map(|(i, q)| {
                // question_repo 和 models 定义了同名但不同的枚举类型，
                // 通过 serde 序列化/反序列化进行跨模块类型转换
                let question_type: Option<QuestionType> = serde_json::to_value(&q.question_type)
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());
                let difficulty: Option<Difficulty> = q
                    .difficulty
                    .as_ref()
                    .and_then(|d| serde_json::to_value(d).ok())
                    .and_then(|v| serde_json::from_value(v).ok());
                let status: QuestionStatus = serde_json::to_value(&q.status)
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();

                ExamCardPreview {
                    card_id: q
                        .card_id
                        .clone()
                        .unwrap_or_else(|| format!("card_fallback_{}", i)),
                    page_index: 0,
                    question_label: q
                        .question_label
                        .clone()
                        .unwrap_or_else(|| format!("Q{}", i + 1)),
                    ocr_text: q.content.clone(),
                    tags: q.tags.clone(),
                    question_type,
                    answer: q.answer.clone(),
                    explanation: q.explanation.clone(),
                    difficulty,
                    status,
                    source_type: SourceType::ImportFile,
                    ..Default::default()
                }
            })
            .collect();

        let preview = ExamSheetPreviewResult {
            temp_id: session_id.to_string(),
            exam_name: Some(qbank_name.to_string()),
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
            session_id: Some(session_id.to_string()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        if is_new_session {
            // 更新 preview_json 和状态
            VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
                .map_err(|e| AppError::database(format!("更新题目集失败: {}", e)))?;
            VfsExamRepo::update_status(vfs_db, session_id, "completed")
                .map_err(|e| AppError::database(format!("更新状态失败: {}", e)))?;
        } else {
            // 追加模式：更新 preview_json
            VfsExamRepo::update_preview_json(vfs_db, session_id, preview_json)
                .map_err(|e| AppError::database(format!("更新题目集失败: {}", e)))?;
        }

        // 刷新统计
        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, session_id) {
            log::warn!("[QuestionBank] 统计刷新失败: {}", e);
        }

        let total = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
        Ok(ImportResult {
            session_id: session_id.to_string(),
            name: qbank_name.to_string(),
            imported_count: total,
            total_questions: total,
        })
    }

    async fn save_questions_to_session_with_id(
        &self,
        vfs_db: &VfsDatabase,
        questions: Vec<Value>,
        request: &ImportRequest,
        session_id: &str,
        qbank_name: &str,
    ) -> Result<ImportResult, AppError> {
        if request.session_id.is_some() {
            return self
                .append_to_existing_session(vfs_db, questions, session_id)
                .await;
        }

        // 1. 第一遍：构建 cards 并收集有效题目及其 card_id
        let mut cards = Vec::new();
        let mut valid_questions: Vec<(usize, &Value, String)> = Vec::new();

        for (i, q) in questions.iter().enumerate() {
            let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if content.is_empty() {
                continue;
            }
            let card = self.question_to_card(q, i);
            let card_id = card.card_id.clone();
            cards.push(card);
            valid_questions.push((i, q, card_id));
        }

        let preview = ExamSheetPreviewResult {
            temp_id: session_id.to_string(),
            exam_name: Some(qbank_name.to_string()),
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
            session_id: Some(session_id.to_string()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        // 2. 先创建 exam_sheet，获取真实的 exam_id
        let params = VfsCreateExamSheetParams {
            exam_name: Some(qbank_name.to_string()),
            temp_id: session_id.to_string(),
            metadata_json: json!({}),
            preview_json,
            status: "completed".to_string(),
            folder_id: request.folder_id.clone(),
        };

        let exam_sheet = VfsExamRepo::create_exam_sheet(vfs_db, params)
            .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;
        let real_exam_id = exam_sheet.id;

        // 3. 使用真实 exam_id 构建 question_params 并写入 questions 表
        let question_params_list: Vec<CreateQuestionParams> = valid_questions
            .iter()
            .map(|(i, q, card_id)| self.json_to_question_params(q, &real_exam_id, card_id, *i))
            .collect();

        if !question_params_list.is_empty() {
            VfsQuestionRepo::batch_create_questions(vfs_db, &question_params_list)
                .map_err(|e| AppError::database(format!("写入题目表失败: {}", e)))?;
            if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &real_exam_id) {
                log::warn!("[QuestionBank] 统计刷新失败: {}", e);
            }
        }

        let total = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
        Ok(ImportResult {
            session_id: real_exam_id,
            name: qbank_name.to_string(),
            imported_count: total,
            total_questions: total,
        })
    }
}

// ============================================================================
// CSV 导入功能
// ============================================================================

/// CSV 导入去重策略
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CsvDuplicateStrategy {
    /// 跳过重复项
    #[default]
    Skip,
    /// 覆盖已有数据
    Overwrite,
    /// 合并（保留旧数据，补充新字段）
    Merge,
}

/// CSV 导入请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportRequest {
    /// 文件路径
    pub file_path: String,
    /// 目标题目集 ID
    pub exam_id: String,
    /// 字段映射：CSV 列名 -> 题目字段名
    pub field_mapping: HashMap<String, String>,
    /// 去重策略
    #[serde(default)]
    pub duplicate_strategy: CsvDuplicateStrategy,
    /// 文件夹 ID（创建新题目集时使用）
    pub folder_id: Option<String>,
    /// 题目集名称（创建新题目集时使用）
    pub exam_name: Option<String>,
}

/// CSV 导入结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportResult {
    /// 导入成功数
    pub success_count: usize,
    /// 跳过数（重复）
    pub skipped_count: usize,
    /// 失败数
    pub failed_count: usize,
    /// 错误详情
    pub errors: Vec<CsvImportError>,
    /// 目标题目集 ID
    pub exam_id: String,
    /// 总处理行数
    pub total_rows: usize,
}

/// CSV 导入错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportError {
    /// 行号（从 1 开始）
    pub row: usize,
    /// 错误信息
    pub message: String,
    /// 原始行内容（可选）
    pub raw_data: Option<String>,
}

/// CSV 导入进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CsvImportProgress {
    /// 开始解析
    Started {
        total_rows: usize,
        file_path: String,
        /// M-022: 会话隔离标识
        exam_id: String,
    },
    /// 处理进度
    Progress {
        current: usize,
        total: usize,
        success: usize,
        skipped: usize,
        failed: usize,
        /// M-022: 会话隔离标识
        exam_id: String,
    },
    /// 完成
    Completed(CsvImportResult),
    /// 失败
    Failed {
        error: String,
        /// M-022: 会话隔离标识
        exam_id: String,
    },
}

/// CSV 预览结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvPreviewResult {
    /// 列名（表头）
    pub headers: Vec<String>,
    /// 预览行数据
    pub rows: Vec<Vec<String>>,
    /// 总行数（不含表头）
    pub total_rows: usize,
    /// 检测到的编码
    pub encoding: String,
}

/// CSV 导入服务
pub struct CsvImportService;

impl CsvImportService {
    /// 预览 CSV 文件前 N 行
    pub fn preview_csv(file_path: &str, preview_rows: usize) -> Result<CsvPreviewResult, AppError> {
        let (content, encoding) = Self::read_file_with_encoding(file_path)?;

        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .has_headers(true)
            .from_reader(content.as_bytes());

        // 获取表头
        let headers: Vec<String> = reader
            .headers()
            .map_err(|e| AppError::validation(format!("读取 CSV 表头失败: {}", e)))?
            .iter()
            .map(|h| h.to_string())
            .collect();

        // 读取预览行
        let mut rows = Vec::new();
        let mut total_rows = 0;

        for result in reader.records() {
            total_rows += 1;
            if rows.len() < preview_rows {
                match result {
                    Ok(record) => {
                        let row: Vec<String> = record.iter().map(|s| s.to_string()).collect();
                        rows.push(row);
                    }
                    Err(e) => {
                        log::warn!("[CsvImport] 预览时跳过第 {} 行: {}", total_rows, e);
                    }
                }
            }
        }

        Ok(CsvPreviewResult {
            headers,
            rows,
            total_rows,
            encoding,
        })
    }

    /// 导入 CSV 文件到题目集
    pub fn import_csv(
        vfs_db: &VfsDatabase,
        request: &CsvImportRequest,
        progress_tx: Option<UnboundedSender<CsvImportProgress>>,
    ) -> Result<CsvImportResult, AppError> {
        log::info!(
            "[CsvImport] 开始导入 CSV: {} -> exam_id={}",
            request.file_path,
            request.exam_id
        );

        // 1. 读取文件并检测编码
        let (content, encoding) = Self::read_file_with_encoding(&request.file_path)?;
        log::info!("[CsvImport] 检测到编码: {}", encoding);

        // 2. 解析 CSV
        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .has_headers(true)
            .from_reader(content.as_bytes());

        // 获取表头
        let headers: Vec<String> = reader
            .headers()
            .map_err(|e| AppError::validation(format!("读取 CSV 表头失败: {}", e)))?
            .iter()
            .map(|h| h.to_string())
            .collect();

        // 验证字段映射
        Self::validate_field_mapping(&headers, &request.field_mapping)?;

        // 获取或创建题目集
        let exam_id = Self::ensure_exam_exists(vfs_db, request)?;

        // 获取现有题目的内容哈希（用于去重）
        // M-035 fix: 使用 mut 以便在插入新题目后更新哈希集合，防止同一 CSV 内重复行
        let mut existing_hashes = Self::get_existing_content_hashes(vfs_db, &exam_id)?;

        // 3. 统计总行数
        let records: Vec<_> = reader.records().collect();
        let total_rows = records.len();

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(CsvImportProgress::Started {
                total_rows,
                file_path: request.file_path.clone(),
                exam_id: exam_id.clone(),
            });
        }

        // 4. 逐行处理
        let mut success_count = 0;
        let mut skipped_count = 0;
        let mut failed_count = 0;
        let mut errors = Vec::new();

        for (idx, result) in records.into_iter().enumerate() {
            let row_num = idx + 2; // CSV 行号从 1 开始，加上表头行

            match result {
                Ok(record) => {
                    match Self::process_csv_row(
                        vfs_db,
                        &exam_id,
                        &headers,
                        &record,
                        &request.field_mapping,
                        &request.duplicate_strategy,
                        &mut existing_hashes,
                        row_num,
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

            // 发送进度
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

        // 5. 刷新统计
        if let Err(e) = VfsQuestionRepo::refresh_stats(vfs_db, &exam_id) {
            log::warn!("[QuestionBank] 统计刷新失败: {}", e);
        }

        let result = CsvImportResult {
            success_count,
            skipped_count,
            failed_count,
            errors,
            exam_id,
            total_rows,
        };

        if let Some(ref tx) = progress_tx {
            let _ = tx.send(CsvImportProgress::Completed(result.clone()));
        }

        log::info!(
            "[CsvImport] 导入完成: success={}, skipped={}, failed={}",
            success_count,
            skipped_count,
            failed_count
        );

        Ok(result)
    }

    /// M-038: 校验文件路径，防止目录遍历攻击
    fn validate_file_path(path: &str) -> Result<(), AppError> {
        let path_str = std::path::Path::new(path).to_string_lossy();
        if path_str.contains("..") {
            return Err(AppError::validation(
                "路径不允许包含 '..' 目录遍历".to_string(),
            ));
        }
        Ok(())
    }

    /// 读取文件并自动检测编码（支持 UTF-8、GBK）
    fn read_file_with_encoding(file_path: &str) -> Result<(String, String), AppError> {
        // M-038: 校验路径，防止目录遍历
        Self::validate_file_path(file_path)?;

        let file = std::fs::File::open(file_path)
            .map_err(|e| AppError::internal(format!("打开文件失败: {}", e)))?;

        let mut reader = BufReader::new(file);
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|e| AppError::internal(format!("读取文件失败: {}", e)))?;

        // 尝试 UTF-8 解码
        if let Ok(content) = String::from_utf8(bytes.clone()) {
            // 检查是否包含 BOM
            let content = if content.starts_with('\u{FEFF}') {
                content[3..].to_string()
            } else {
                content
            };
            return Ok((content, "UTF-8".to_string()));
        }

        // 尝试 GBK 解码
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(&bytes);
        if !had_errors {
            return Ok((decoded.to_string(), "GBK".to_string()));
        }

        // 回退到 GB18030（GBK 的超集）
        let (decoded, _, _) = encoding_rs::GB18030.decode(&bytes);
        Ok((decoded.to_string(), "GB18030".to_string()))
    }

    /// 验证字段映射
    fn validate_field_mapping(
        headers: &[String],
        field_mapping: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        // content 字段是必需的
        let has_content = field_mapping.values().any(|v| v == "content");
        if !has_content {
            return Err(AppError::validation("字段映射中必须包含 content 字段"));
        }

        // 检查映射的 CSV 列是否存在
        for csv_col in field_mapping.keys() {
            if !headers.contains(csv_col) {
                return Err(AppError::validation(format!(
                    "CSV 文件中不存在列 '{}'，可用列: {:?}",
                    csv_col, headers
                )));
            }
        }

        Ok(())
    }

    /// 确保题目集存在（创建或使用现有）
    fn ensure_exam_exists(
        vfs_db: &VfsDatabase,
        request: &CsvImportRequest,
    ) -> Result<String, AppError> {
        // 检查题目集是否存在
        if let Ok(Some(_)) = VfsExamRepo::get_exam_sheet(vfs_db, &request.exam_id) {
            return Ok(request.exam_id.clone());
        }

        // 创建新题目集
        let exam_name = request.exam_name.clone().unwrap_or_else(|| {
            let file_name = std::path::Path::new(&request.file_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("CSV导入");
            format!("CSV导入 - {}", file_name)
        });

        let preview = ExamSheetPreviewResult {
            temp_id: request.exam_id.clone(),
            exam_name: Some(exam_name.clone()),
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
            session_id: Some(request.exam_id.clone()),
        };

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| AppError::validation(format!("序列化失败: {}", e)))?;

        let params = VfsCreateExamSheetParams {
            exam_name: Some(exam_name),
            temp_id: request.exam_id.clone(),
            metadata_json: json!({}),
            preview_json,
            status: "completed".to_string(),
            folder_id: request.folder_id.clone(),
        };

        VfsExamRepo::create_exam_sheet(vfs_db, params)
            .map_err(|e| AppError::database(format!("创建题目集失败: {}", e)))?;

        Ok(request.exam_id.clone())
    }

    /// 获取现有题目的内容哈希集合
    ///
    /// M-036 fix: 使用直接 SQL 查询只获取 id 和 content 列，移除 10,000 条分页限制，
    /// 确保大题库也能正确去重。
    fn get_existing_content_hashes(
        vfs_db: &VfsDatabase,
        exam_id: &str,
    ) -> Result<HashMap<String, String>, AppError> {
        use rusqlite::params;

        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let mut stmt = conn
            .prepare("SELECT id, content FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL")
            .map_err(|e| AppError::database(format!("准备查询语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![exam_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::database(format!("查询现有题目失败: {}", e)))?;

        let mut hashes = HashMap::new();
        for row in rows {
            let (id, content) =
                row.map_err(|e| AppError::database(format!("读取题目行失败: {}", e)))?;
            let hash = Self::compute_content_hash(&content);
            hashes.insert(hash, id);
        }

        Ok(hashes)
    }

    /// 计算内容哈希
    fn compute_content_hash(content: &str) -> String {
        let normalized = content.trim().replace([' ', '\t', '\r', '\n'], "");

        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        let result = hasher.finalize();
        hex::encode(&result[..16]) // 使用前 16 字节
    }

    /// 处理单行 CSV 数据
    fn process_csv_row(
        vfs_db: &VfsDatabase,
        exam_id: &str,
        headers: &[String],
        record: &csv::StringRecord,
        field_mapping: &HashMap<String, String>,
        duplicate_strategy: &CsvDuplicateStrategy,
        existing_hashes: &mut HashMap<String, String>,
        row_num: usize,
    ) -> Result<CsvRowResult, AppError> {
        // 构建字段值映射
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

        // 获取必需字段
        let content = field_values
            .get("content")
            .ok_or_else(|| AppError::validation(format!("第 {} 行: content 字段为空", row_num)))?;

        if content.trim().is_empty() {
            return Err(AppError::validation(format!(
                "第 {} 行: content 字段为空",
                row_num
            )));
        }

        // 检查重复
        let content_hash = Self::compute_content_hash(content);
        if let Some(existing_id) = existing_hashes.get(&content_hash) {
            match duplicate_strategy {
                CsvDuplicateStrategy::Skip => {
                    return Ok(CsvRowResult::Skipped);
                }
                CsvDuplicateStrategy::Overwrite => {
                    // 更新现有题目
                    let params = Self::build_update_params(&field_values);
                    VfsQuestionRepo::update_question(vfs_db, existing_id, &params)
                        .map_err(|e| AppError::database(format!("更新题目失败: {}", e)))?;
                    return Ok(CsvRowResult::Updated);
                }
                CsvDuplicateStrategy::Merge => {
                    // 获取现有题目并合并
                    if let Ok(Some(existing)) = VfsQuestionRepo::get_question(vfs_db, existing_id) {
                        let params = Self::build_merge_params(&field_values, &existing);
                        VfsQuestionRepo::update_question(vfs_db, existing_id, &params)
                            .map_err(|e| AppError::database(format!("合并题目失败: {}", e)))?;
                        return Ok(CsvRowResult::Updated);
                    }
                }
            }
        }

        // 创建新题目
        let params = Self::build_create_params(exam_id, &field_values, row_num);
        let new_question = VfsQuestionRepo::create_question(vfs_db, &params)
            .map_err(|e| AppError::database(format!("创建题目失败: {}", e)))?;

        // M-035 fix: 将新题目的哈希加入集合，防止同一 CSV 内后续重复行再次插入
        existing_hashes.insert(content_hash, new_question.id);

        Ok(CsvRowResult::Success)
    }

    /// 构建创建参数
    fn build_create_params(
        exam_id: &str,
        field_values: &HashMap<String, String>,
        row_num: usize,
    ) -> CreateQuestionParams {
        let content = field_values.get("content").cloned().unwrap_or_default();

        // 解析选项（支持格式："A. xxx; B. yyy" 或 JSON 格式）
        let options = field_values
            .get("options")
            .and_then(|opts_str| Self::parse_options_string(opts_str));

        // 解析题目类型
        let question_type = field_values
            .get("question_type")
            .and_then(|t| Self::parse_question_type(t));

        // 解析难度
        let difficulty = field_values
            .get("difficulty")
            .and_then(|d| Self::parse_difficulty(d));

        // 解析标签
        let tags = field_values.get("tags").and_then(|t| Self::parse_tags(t));

        CreateQuestionParams {
            exam_id: exam_id.to_string(),
            card_id: Some(format!("csv_{}", nanoid::nanoid!(10))),
            question_label: field_values
                .get("question_label")
                .cloned()
                .or_else(|| Some(format!("Q{}", row_num - 1))),
            content,
            options,
            answer: field_values.get("answer").cloned(),
            explanation: field_values.get("explanation").cloned(),
            question_type,
            difficulty,
            tags,
            source_type: Some(crate::vfs::repos::SourceType::Imported),
            source_ref: Some("csv".to_string()),
            images: None,
            parent_id: None,
        }
    }

    /// 构建更新参数（覆盖模式）
    fn build_update_params(
        field_values: &HashMap<String, String>,
    ) -> crate::vfs::repos::UpdateQuestionParams {
        let mut params = crate::vfs::repos::UpdateQuestionParams::default();

        if let Some(content) = field_values.get("content") {
            params.content = Some(content.clone());
        }
        if let Some(answer) = field_values.get("answer") {
            params.answer = Some(answer.clone());
        }
        if let Some(explanation) = field_values.get("explanation") {
            params.explanation = Some(explanation.clone());
        }
        if let Some(opts_str) = field_values.get("options") {
            params.options = Self::parse_options_string(opts_str);
        }
        if let Some(qt) = field_values.get("question_type") {
            params.question_type = Self::parse_question_type(qt);
        }
        if let Some(diff) = field_values.get("difficulty") {
            params.difficulty = Self::parse_difficulty(diff);
        }
        if let Some(tags_str) = field_values.get("tags") {
            params.tags = Self::parse_tags(tags_str);
        }

        params
    }

    /// 构建合并参数（仅更新空字段）
    fn build_merge_params(
        field_values: &HashMap<String, String>,
        existing: &crate::vfs::repos::Question,
    ) -> crate::vfs::repos::UpdateQuestionParams {
        let mut params = crate::vfs::repos::UpdateQuestionParams::default();

        // 仅更新空字段
        if existing.answer.is_none() {
            if let Some(answer) = field_values.get("answer") {
                params.answer = Some(answer.clone());
            }
        }
        if existing.explanation.is_none() {
            if let Some(explanation) = field_values.get("explanation") {
                params.explanation = Some(explanation.clone());
            }
        }
        if existing.options.is_none() {
            if let Some(opts_str) = field_values.get("options") {
                params.options = Self::parse_options_string(opts_str);
            }
        }
        if existing.tags.is_empty() {
            if let Some(tags_str) = field_values.get("tags") {
                params.tags = Self::parse_tags(tags_str);
            }
        }

        params
    }

    /// 解析选项字符串
    fn parse_options_string(opts_str: &str) -> Option<Vec<crate::vfs::repos::QuestionOption>> {
        let opts_str = opts_str.trim();

        // 尝试 JSON 格式
        if opts_str.starts_with('[') {
            if let Ok(opts) =
                serde_json::from_str::<Vec<crate::vfs::repos::QuestionOption>>(opts_str)
            {
                return Some(opts);
            }
        }

        // 尝试解析 "A. xxx; B. yyy" 或 "A. xxx\nB. yyy" 格式
        let separators = [';', '\n', '|'];
        for sep in separators {
            let parts: Vec<&str> = opts_str
                .split(sep)
                .filter(|s| !s.trim().is_empty())
                .collect();
            if parts.len() >= 2 {
                let options: Vec<crate::vfs::repos::QuestionOption> = parts
                    .iter()
                    .filter_map(|part| {
                        let part = part.trim();
                        // 匹配 "A. xxx" 或 "A xxx" 或 "A、xxx" 格式
                        let re = regex::Regex::new(r"^([A-Za-z])[\.、\s]\s*(.+)$").ok()?;
                        if let Some(caps) = re.captures(part) {
                            let key = caps.get(1)?.as_str().to_uppercase();
                            let content = caps.get(2)?.as_str().to_string();
                            return Some(crate::vfs::repos::QuestionOption { key, content });
                        }
                        None
                    })
                    .collect();

                if !options.is_empty() {
                    return Some(options);
                }
            }
        }

        None
    }

    /// 解析题目类型
    fn parse_question_type(s: &str) -> Option<crate::vfs::repos::QuestionType> {
        let s_lower = s.trim().to_lowercase();
        match s_lower.as_str() {
            "single_choice" | "单选" | "单选题" => {
                Some(crate::vfs::repos::QuestionType::SingleChoice)
            }
            "multiple_choice" | "多选" | "多选题" => {
                Some(crate::vfs::repos::QuestionType::MultipleChoice)
            }
            "indefinite_choice" | "不定项" | "不定项选择" => {
                Some(crate::vfs::repos::QuestionType::IndefiniteChoice)
            }
            "fill_blank" | "填空" | "填空题" => {
                Some(crate::vfs::repos::QuestionType::FillBlank)
            }
            "short_answer" | "简答" | "简答题" => {
                Some(crate::vfs::repos::QuestionType::ShortAnswer)
            }
            "essay" | "论述" | "论述题" => Some(crate::vfs::repos::QuestionType::Essay),
            "calculation" | "计算" | "计算题" => {
                Some(crate::vfs::repos::QuestionType::Calculation)
            }
            "proof" | "证明" | "证明题" => Some(crate::vfs::repos::QuestionType::Proof),
            _ => Some(crate::vfs::repos::QuestionType::Other),
        }
    }

    /// 解析难度
    fn parse_difficulty(s: &str) -> Option<crate::vfs::repos::Difficulty> {
        let s_lower = s.trim().to_lowercase();
        match s_lower.as_str() {
            "easy" | "简单" | "1" => Some(crate::vfs::repos::Difficulty::Easy),
            "medium" | "中等" | "2" => Some(crate::vfs::repos::Difficulty::Medium),
            "hard" | "困难" | "难" | "3" => Some(crate::vfs::repos::Difficulty::Hard),
            "very_hard" | "极难" | "4" => Some(crate::vfs::repos::Difficulty::VeryHard),
            _ => None,
        }
    }

    /// 解析标签
    fn parse_tags(s: &str) -> Option<Vec<String>> {
        let s = s.trim();

        // 尝试 JSON 格式
        if s.starts_with('[') {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(s) {
                return Some(tags);
            }
        }

        // 尝试分隔符格式
        let separators = [',', ';', '|', '、'];
        for sep in separators {
            if s.contains(sep) {
                let tags: Vec<String> = s
                    .split(sep)
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
                if !tags.is_empty() {
                    return Some(tags);
                }
            }
        }

        // 单个标签
        if !s.is_empty() {
            return Some(vec![s.to_string()]);
        }

        None
    }
}

/// CSV 行处理结果
enum CsvRowResult {
    /// 新建成功
    Success,
    /// 跳过（重复）
    Skipped,
    /// 更新成功
    Updated,
}
