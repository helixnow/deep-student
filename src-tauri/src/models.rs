use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use tokio::sync::AcquireError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" 或 "assistant"
    pub content: String,
    pub timestamp: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_content: Option<String>,
    /// Gemini 3 思维签名（工具调用必需）
    /// 在工具调用场景下，API 返回的 thoughtSignature 需要在后续请求中回传
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rag_sources: Option<Vec<RagSourceInfo>>,
    // 新增：智能记忆来源（与RAG分开存储/展示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_sources: Option<Vec<RagSourceInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_sources: Option<Vec<RagSourceInfo>>,
    // 新增：外部搜索来源（与RAG/Memory分开存储/展示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search_sources: Option<Vec<RagSourceInfo>>,
    // 修复BUG-05：新增图片字段支持多模态对话
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_paths: Option<Vec<String>>, // 用户消息中包含的图片路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_base64: Option<Vec<String>>, // 备用：base64编码的图片数据
    // 新增：文档附件支持
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_attachments: Option<Vec<DocumentAttachment>>, // 文档附件信息
    // ★ 文档25：多模态内容块（图文交替顺序）
    // 当存在此字段时，LLMManager 应优先使用它构建 content 数组，而非分离的 content + image_base64
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multimodal_content: Option<Vec<MultimodalContentPart>>,
    // 🔧 B1: 标准工具调用协议（可选字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<ToolResult>,
    // 统一管线：消息级覆盖与关系（JSON透传，便于逐步落库）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relations: Option<serde_json::Value>,
    // SOTA: 前端生成的稳定ID，用于增量保存
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_stable_id: Option<String>,
    // 时间线元数据：阶段信息、工具事件、锚点等（前端_meta字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// B1: 工具调用与返回定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,                   // 工具调用ID（关联结果用）
    pub tool_name: String,            // 工具名称
    pub args_json: serde_json::Value, // 调用参数（JSON）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String, // 对应的调用ID
    pub ok: bool,        // 是否成功
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>, // 失败时错误信息（向后兼容）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_details: Option<crate::error_details::ErrorDetails>, // 详细错误信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_json: Option<serde_json::Value>, // 成功时数据
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>, // 资源/成本使用（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<RagSourceInfo>>, // P0: 工具引文标准化，与前端对齐
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSourceInfo {
    pub document_id: String,
    pub file_name: String,
    pub chunk_text: String,
    pub score: f32,
    pub chunk_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentAttachment {
    pub name: String,      // 文件名
    pub mime_type: String, // MIME 类型
    pub size_bytes: usize, // 文件大小（字节）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>, // 提取的文本内容（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64_content: Option<String>, // Base64 编码的原始内容（可选）
}

/// ★ 文档25：多模态内容部分（图文交替）
///
/// 用于支持 OpenAI/Anthropic/Gemini 的多模态消息格式。
/// 当 ChatMessage.multimodal_content 存在时，LLMManager 应优先使用此字段构建请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MultimodalContentPart {
    /// 文本内容部分
    Text {
        /// 文本内容
        text: String,
    },
    /// 图片内容部分
    #[serde(rename = "image_url")]
    ImageUrl {
        /// MIME 类型（如 image/png, image/jpeg）
        #[serde(rename = "mediaType")]
        media_type: String,
        /// Base64 编码的图片数据（不含 data: 前缀）
        base64: String,
    },
}

impl MultimodalContentPart {
    /// 创建文本内容部分
    pub fn text(text: impl Into<String>) -> Self {
        MultimodalContentPart::Text { text: text.into() }
    }

    /// 创建图片内容部分
    pub fn image(media_type: impl Into<String>, base64: impl Into<String>) -> Self {
        MultimodalContentPart::ImageUrl {
            media_type: media_type.into(),
            base64: base64.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TempStreamState {
    InProgress,
    Completed,
    Failed,
}

impl Default for TempStreamState {
    fn default() -> Self {
        TempStreamState::InProgress
    }
}

impl TempStreamState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TempStreamState::InProgress => "in_progress",
            TempStreamState::Completed => "completed",
            TempStreamState::Failed => "failed",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "completed" => TempStreamState::Completed,
            "failed" => TempStreamState::Failed,
            _ => TempStreamState::InProgress,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeLinkContext {
    pub source_id: String,
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub business_session_id: Option<String>,
}

/// 首轮流式上下文：存储图片、OCR、聊天历史等数据
/// 注意：这不是"临时会话"，而是首轮分析的完整上下文缓存
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamContext {
    /// 错题ID（首轮即正式架构：直接是正式的mistake_id）
    /// 注：暂时保留 temp_id 字段名以保持后端兼容，前端将迁移到 mistake_id
    #[serde(alias = "mistake_id")]
    pub temp_id: String,
    pub question_images: Vec<String>,
    pub analysis_images: Vec<String>,
    pub user_question: String,
    pub ocr_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_note: Option<String>,
    pub tags: Vec<String>,
    pub mistake_type: String,
    pub chat_category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_metadata: Option<ChatMetadata>,
    pub chat_history: Vec<ChatMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_doc_attachments: Option<Vec<DocumentAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_images: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_sheet: Option<MistakeExamSheetLink>,
    #[serde(default)]
    pub stream_state: TempStreamState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_context: Option<BridgeLinkContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatMetadata {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MistakeExamSheetLink {
    pub exam_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_exam_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_mistake_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cropped_image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mistake_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamSheetSessionMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_model_response: Option<Value>,
    #[serde(default)]
    pub source_type: SourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_source: Option<ImportSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<QuestionBankStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamSheetSessionSummary {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,
    pub temp_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ExamSheetSessionMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_mistake_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionDetail {
    pub summary: ExamSheetSessionSummary,
    pub preview: ExamSheetPreviewResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamCardBBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

// ============ 智能题目集 (QuestionBank) 扩展类型 ============

/// 题目类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    SingleChoice,     // 单选题
    MultipleChoice,   // 多选题
    IndefiniteChoice, // 不定项选择题
    FillBlank,        // 填空题
    ShortAnswer,      // 简答题
    Essay,            // 论述题
    Calculation,      // 计算题
    Proof,            // 证明题
    Other,            // 其他
}

impl Default for QuestionType {
    fn default() -> Self {
        QuestionType::Other
    }
}

/// 难度等级
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Difficulty {
    Easy,     // 简单
    Medium,   // 中等
    Hard,     // 困难
    VeryHard, // 极难
}

impl Default for Difficulty {
    fn default() -> Self {
        Difficulty::Medium
    }
}

/// 学习状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    New,        // 新题，未做过
    InProgress, // 学习中
    Mastered,   // 已掌握
    Review,     // 需复习（做错过）
}

impl Default for QuestionStatus {
    fn default() -> Self {
        QuestionStatus::New
    }
}

/// 来源类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    OcrImage,     // 图片 OCR 识别
    ImportFile,   // 文件导入
    ManualCreate, // 手动创建
    AiGenerated,  // AI 生成（变式）
}

impl Default for SourceType {
    fn default() -> Self {
        SourceType::OcrImage
    }
}

/// 导入来源详情
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImportSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_time: Option<String>,
}

/// 题目集统计信息
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuestionBankStats {
    pub total_count: i32,
    pub mastered_count: i32,
    pub review_count: i32,
    pub in_progress_count: i32,
    pub new_count: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
}

// ============ 智能题目集扩展类型结束 ============

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamCardPreview {
    #[serde(default)]
    pub card_id: String,
    #[serde(default)]
    pub page_index: usize,
    #[serde(default)]
    pub question_label: String,
    #[serde(default)]
    pub bbox: ExamCardBBox,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cropped_image_path: String,
    #[serde(default)]
    pub ocr_text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_mistake_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_type: Option<QuestionType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<Difficulty>,
    #[serde(default)]
    pub status: QuestionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_correct: Option<bool>,
    #[serde(default)]
    pub attempt_count: i32,
    #[serde(default)]
    pub correct_count: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
    #[serde(default)]
    pub source_type: SourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_info: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_card_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetPreviewPage {
    pub page_index: usize,
    /// ★ 新字段：VFS blob 哈希引用（新数据使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,
    /// ★ 新字段：图片宽度（像素）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// ★ 新字段：图片高度（像素）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// ★ 兼容性字段：旧数据使用文件系统路径
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub original_image_path: String,
    pub cards: Vec<ExamCardPreview>,
    /// ★ 两阶段可恢复：阶段一 OCR 原始文本（逐页持久化，恢复时跳过已完成的页）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_ocr_text: Option<String>,
    /// ★ 两阶段可恢复：阶段一完成标志
    #[serde(default)]
    pub ocr_completed: bool,
    /// ★ 两阶段可恢复：阶段二完成标志
    #[serde(default)]
    pub parse_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetPreviewResult {
    /// 临时 ID，用于关联会话
    /// 兼容旧数据：缺失时使用空字符串
    #[serde(default)]
    pub temp_id: String,
    pub exam_name: Option<String>,
    #[serde(default)]
    pub pages: Vec<ExamSheetPreviewPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_model_response: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetPreviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,
    pub page_images: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grouping_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grouping_focus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<ExamSheetOutputFormat>,
    /// ★ 追加模式：如果提供 session_id，将新识别的 pages 追加到现有会话
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExamSheetOutputFormat {
    #[serde(rename = "deepseek_ocr")]
    DeepseekOcr,
}

impl Default for ExamSheetOutputFormat {
    fn default() -> Self {
        Self::DeepseekOcr
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamSheetSegmentationOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<ExamSheetOutputFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grouping_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grouping_focus: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOcrPageInput {
    pub page_index: usize,
    pub image_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOcrRequest {
    pub pdf_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_name: Option<String>,
    pub pages: Vec<PdfOcrPageInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOcrTextBlock {
    pub text: String,
    pub bbox: ExamCardBBox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOcrPageResult {
    pub page_index: usize,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    pub blocks: Vec<PdfOcrTextBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfOcrResult {
    pub temp_id: String,
    pub source_pdf_path: String,
    pub pdfstream_url: String,
    pub page_results: Vec<PdfOcrPageResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ExamSheetSegmentationProgress {
    SessionCreated {
        detail: ExamSheetSessionDetail,
        total_pages: usize,
    },
    // ★ 兼容旧前端：保留 ChunkCompleted（映射为 OcrPageCompleted 语义）
    ChunkCompleted {
        detail: ExamSheetSessionDetail,
        chunk_index: usize,
        total_chunks: usize,
    },
    // ★ 阶段一：单页 OCR 完成
    OcrPageCompleted {
        detail: ExamSheetSessionDetail,
        page_index: usize,
        total_pages: usize,
    },
    // ★ 阶段一全部完成
    OcrPhaseCompleted {
        detail: ExamSheetSessionDetail,
        total_pages: usize,
    },
    // ★ 阶段二：单页题目解析完成
    ParsePageCompleted {
        detail: ExamSheetSessionDetail,
        page_index: usize,
        total_pages: usize,
    },
    Completed {
        detail: ExamSheetSessionDetail,
    },
    Failed {
        session_id: Option<String>,
        error: String,
        detail: Option<ExamSheetSessionDetail>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamSheetCardUpdate {
    pub card_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExamSheetCardCreate {
    pub page_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_bbox: Option<ExamCardBBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateExamSheetCardsRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cards: Option<Vec<ExamSheetCardUpdate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_cards: Option<Vec<ExamSheetCardCreate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_card_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateExamSheetCardsResponse {
    pub detail: ExamSheetSessionDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameExamSheetSessionRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameExamSheetSessionResponse {
    pub summary: ExamSheetSessionSummary,
}

// 🔧 新增：统一数据导入导出格式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedBackupData {
    pub version: String,          // 备份格式版本
    pub timestamp: DateTime<Utc>, // 备份时间
    pub backup_type: String,      // "full" | "mistakes_only" | "settings_only"

    // 传统数据
    pub traditional_data: TraditionalBackupData,

    // 元数据
    pub metadata: BackupMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraditionalBackupData {
    pub settings: BackupSettings,
    pub statistics: Option<Statistics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSettings {
    pub system_settings: std::collections::HashMap<String, String>,
    pub api_configurations: Vec<crate::llm_manager::ApiConfig>,
    pub model_assignments: Option<ModelAssignments>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupMetadata {
    pub total_size_mb: f64,
    pub image_backup_stats: ImageBackupStats,
    pub export_options: UnifiedExportOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBackupStats {
    pub total_question_images: usize,
    pub total_analysis_images: usize,
    pub successful_question_images: usize,
    pub successful_analysis_images: usize,
    pub backup_success_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedExportOptions {
    pub include_images: bool,
    pub include_embeddings: bool,
    pub include_settings: bool,
    pub include_statistics: bool,
}

// 研究报告（全库研究结果）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchReport {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub segments: i32,
    pub context_window: i32,
    pub report: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchReportSummary {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub segments: i32,
    pub context_window: i32,
}

#[derive(Debug, Deserialize)]
pub struct AnalysisRequest {
    pub question_image_files: Vec<String>, // base64编码的图片
    pub analysis_image_files: Vec<String>, // base64编码的图片
    pub user_question: String,
    #[serde(default)]
    pub enable_chain_of_thought: bool, // 是否启用思维链
    // 新增：首页首条消息与文档附件（可选）
    #[serde(default)]
    pub initial_user_text: Option<String>,
    #[serde(default)]
    pub doc_attachments: Option<Vec<DocumentAttachment>>,
    #[serde(default)]
    pub exam_sheet: Option<MistakeExamSheetLink>,
    /// 🎯 新架构兼容：前端传入的会话 ID（如果提供则使用，否则后端生成）
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GeneralChatRequest {
    pub user_question: String,
    #[serde(default)]
    pub question_image_files: Vec<String>,
    #[serde(default)]
    pub doc_attachments: Option<Vec<DocumentAttachment>>,
    #[serde(default)]
    pub enable_chain_of_thought: bool,
    /// 🎯 新架构兼容：前端传入的会话 ID
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralChatResponse {
    pub mistake_id: String,
    pub temp_id: String,
    pub business_session_id: String,
    pub generation_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ChatMetadata>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateChatMetadataRequest {
    #[serde(default)]
    pub temp_id: Option<String>,
    #[serde(default)]
    pub mistake_id: Option<String>,
    #[serde(default)]
    pub conversation_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateChatMetadataResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ChatMetadata>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChatMetadataNoteRequest {
    #[serde(default)]
    pub temp_id: Option<String>,
    #[serde(default)]
    pub mistake_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateChatMetadataNoteResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ChatMetadata>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateOcrNoteRequest {
    #[serde(default)]
    pub temp_id: Option<String>,
    #[serde(default)]
    pub mistake_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateOcrNoteResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_note: Option<String>,
}

// Bridge专用分析请求结构
#[derive(Debug, Deserialize)]
pub struct BridgeAnalysisRequest {
    pub source_id: String,     // Bridge来源ID
    pub source_type: String,   // Bridge来源类型
    pub ocr_text: String,      // Bridge构造的OCR文本
    pub user_question: String, // 用户问题描述
    pub tags: Vec<String>,     // Bridge提供的标签
    pub images: Vec<String>,   // 图片文件路径
}

// OCR结果结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    pub text: String,
    pub confidence: f64,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct AnalysisResponse {
    pub mistake_id: String,
    pub temp_id: String,
    pub business_session_id: String,
    pub generation_id: i64,
    pub initial_data: InitialAnalysisData,
}

#[derive(Debug, Serialize)]
pub struct InitialAnalysisData {
    pub ocr_text: String,
    pub tags: Vec<String>,
    pub mistake_type: String,
    pub first_answer: String,
}

#[derive(Debug, Deserialize)]
pub struct ContinueChatRequest {
    pub temp_id: String,
    pub chat_history: Vec<ChatMessage>,
    pub enable_chain_of_thought: Option<bool>,
    #[serde(default)]
    pub enable_rag: Option<bool>,
    #[serde(default)]
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub model2_override_id: Option<String>,
    // 🆕 本轮追问新增图片（base64），优先写入最后一条用户消息
    #[serde(default)]
    pub question_image_files: Option<Vec<String>>,
    // 🔧 新增：追问时的文档附件支持
    #[serde(default)]
    pub document_attachments: Option<Vec<DocumentAttachment>>,
    // 🔧 新增：消息级选择 - MCP 工具与搜索引擎
    #[serde(default)]
    pub mcp_tools: Option<Vec<String>>,
    #[serde(default)]
    pub search_engines: Option<Vec<String>>,
    // 🆕 B4: 视觉质量策略（用于后端按需压缩/降采样）
    #[serde(default)]
    pub vision_quality: Option<String>, // low|medium|high
}

#[derive(Debug, Serialize)]
pub struct ContinueChatResponse {
    pub new_assistant_message: String,
}
// default_save_source 已删除（仅被废弃的 SaveMistakeResponse 使用）

// 回顾分析相关结构
#[derive(Debug, Serialize)]
pub struct ReviewSessionResponse {
    pub review_id: String,
    pub analysis_summary: String,
    pub chat_history: Option<Vec<ChatMessage>>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewChatRequest {
    pub review_id: String,
    pub new_message: ChatMessage,
    pub chat_history: Vec<ChatMessage>,
}

// 结构化错误处理
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AppErrorType {
    Validation,
    Database,
    LLM,
    FileSystem,
    NotFound,
    Configuration,
    Network,
    Conflict,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub error_type: AppErrorType,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(error_type: AppErrorType, message: impl Into<String>) -> Self {
        Self {
            error_type,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        error_type: AppErrorType,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self {
            error_type,
            message: message.into(),
            details: Some(details),
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Validation, message)
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Database, message)
    }

    pub fn llm(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::LLM, message)
    }

    pub fn file_system(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::FileSystem, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::NotFound, message)
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Configuration, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Network, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Unknown, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Unknown, message)
    }

    pub fn operation_failed(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Unknown, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(AppErrorType::Conflict, message)
    }

    pub fn not_implemented(message: impl Into<String>) -> Self {
        // 用未知错误类型表示未实现，以便前端展示友好信息
        Self::new(AppErrorType::Unknown, message)
    }
}

// 为AppError实现From trait以支持自动转换
impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::validation(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::validation(message.to_string())
    }
}

// 实现Display trait
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

// 实现Error trait
impl std::error::Error for AppError {}

// 实现从其他错误类型的转换
impl From<zip::result::ZipError> for AppError {
    fn from(err: zip::result::ZipError) -> Self {
        AppError::file_system(format!("ZIP操作错误: {}", err))
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::unknown(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::validation(format!("JSON序列化错误: {}", err))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::file_system(format!("文件系统错误: {}", err))
    }
}

impl From<AcquireError> for AppError {
    fn from(err: AcquireError) -> Self {
        AppError::new(
            AppErrorType::Unknown,
            format!("Failed to acquire semaphore permit: {}", err),
        )
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::database(format!("数据库错误: {}", err))
    }
}

// 新增：错题总结生成相关结构
#[derive(Debug, Deserialize)]
pub struct GenerateMistakeSummaryRequest {
    pub mistake_id: String,
    pub force_regenerate: Option<bool>, // 是否强制重新生成总结
}

#[derive(Debug, Serialize)]
pub struct GenerateMistakeSummaryResponse {
    pub success: bool,
    pub mistake_summary: Option<String>,
    pub user_error_analysis: Option<String>,
    pub error_message: Option<String>,
}

// 聊天回合删除的详细返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteChatTurnResult {
    pub mistake_id: String,
    pub turn_id: String,
    pub deleted_count: usize,
    pub full_turn_deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// 管理工具：孤儿助手与遗留tool行的条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanAssistantRow {
    pub id: i64,
    pub mistake_id: String,
    pub timestamp: DateTime<Utc>,
    pub content_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRowSample {
    pub id: i64,
    pub mistake_id: String,
    pub timestamp: DateTime<Utc>,
    pub role: String,
    pub content_preview: String,
}

// anyhow 会自动为实现了 std::error::Error 的类型提供转换

// 统一AI接口的输出结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandardModel1Output {
    pub ocr_text: String,
    pub tags: Vec<String>,
    pub mistake_type: String,
    pub raw_response: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandardModel2Output {
    pub assistant_message: String,
    pub raw_response: Option<String>,
    pub chain_of_thought_details: Option<serde_json::Value>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    pub content: String,
    pub is_complete: bool,
    pub chunk_id: String,
}

// 模型分配结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ModelAssignments {
    pub model2_config_id: Option<String>,
    pub review_analysis_model_config_id: Option<String>, // 回顾分析模型配置ID
    pub anki_card_model_config_id: Option<String>,       // Anki制卡模型配置ID
    pub qbank_ai_grading_model_config_id: Option<String>, // 题库AI批改/解析模型配置ID
    pub embedding_model_config_id: Option<String>,       // 新增: 第五模型（嵌入模型）配置ID
    pub reranker_model_config_id: Option<String>,        // 新增: 第六模型（重排序模型）配置ID
    pub chat_title_model_config_id: Option<String>,      // 新增：常规聊天标题生成模型配置ID
    pub exam_sheet_ocr_model_config_id: Option<String>,  // 新增：题目集识别OCR专用模型配置ID
    pub translation_model_config_id: Option<String>,     // 新增：翻译专用模型配置ID
    // ★ 多模态知识库模型配置（文档：multimodal-knowledge-base-design.md）
    pub vl_embedding_model_config_id: Option<String>, // 多模态嵌入模型（Qwen3-VL-Embedding）
    pub vl_reranker_model_config_id: Option<String>,  // 多模态重排序模型（Qwen3-VL-Reranker）
    pub memory_decision_model_config_id: Option<String>, // 记忆决策模型（smart write 去重判断）
    pub voice_input_asr_model_config_id: Option<String>, // 语音输入 ASR 模型
    pub image_generation_model_config_id: Option<String>, // 生图模型
    /// 聊天内翻译弹窗的显示模式："aligned"（短语对照，默认）| "streaming"（流式纯译文）
    pub translation_display_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewAnalysisRequest {
    pub mistake_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Statistics {
    pub total_reviews: i32,
    pub type_stats: std::collections::HashMap<String, i32>,
    pub tag_stats: std::collections::HashMap<String, i32>,
}

// ===================== Review (Consolidated) Models =====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSession {
    pub id: String,
    pub mistake_ids: Vec<String>,
    pub analysis_summary: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub chat_history: Vec<ReviewChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewAnalysisItem {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub mistake_ids: Vec<String>,
    pub consolidated_input: String,
    pub user_question: String,
    pub status: String,
    pub tags: Vec<String>,
    pub analysis_type: String,
    pub chat_history: Vec<ChatMessage>,
}

#[derive(Debug, Deserialize)]
pub struct StartStreamingAnswerRequest {
    pub temp_id: String,
    pub enable_chain_of_thought: bool,
    #[serde(default)]
    pub enable_rag: Option<bool>,
    #[serde(default)]
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub model2_override_id: Option<String>,
    // 🆕 可选：首轮启动时额外携带的图片（base64），若存在则写入最后一条用户消息
    #[serde(default)]
    pub question_image_files: Option<Vec<String>>,
    // 🆕 B4: 视觉质量策略（用于后端按需压缩/降采样）
    #[serde(default)]
    pub vision_quality: Option<String>, // low|medium|high
}

// 模板描述结构体 - 供 LLM 理解模板用途
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateDescription {
    pub id: String,
    pub name: String,
    pub description: String,
    pub fields: Vec<String>,
    /// 模板的生成提示词，指导 LLM 如何构造该模板的 JSON 字段
    #[serde(default)]
    pub generation_prompt: Option<String>,
}

// ANKI相关结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiGenerationOptions {
    pub deck_name: String,
    pub note_type: String,
    pub enable_images: bool,
    pub max_cards_per_mistake: i32,
    /// 全文档卡片总上限（可选）。当存在分段任务时，服务会按分段分配额度，避免总数失控。
    #[serde(default)]
    pub max_cards_total: Option<i32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
    // 新增：AI行为参数覆盖值
    #[serde(default)]
    pub max_output_tokens_override: Option<u32>,
    #[serde(default)]
    pub temperature_override: Option<f32>,
    // 新增：模板系统参数
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub custom_anki_prompt: Option<String>,
    #[serde(default)]
    pub template_fields: Option<Vec<String>>,
    // 新增：字段提取规则用于动态解析
    #[serde(default)]
    pub field_extraction_rules: Option<std::collections::HashMap<String, FieldExtractionRule>>,
    // 多模板：按模板ID分组的字段列表
    #[serde(default)]
    pub template_fields_by_id: Option<std::collections::HashMap<String, Vec<String>>>,
    // 多模板：按模板ID分组的字段提取规则
    #[serde(default)]
    pub field_extraction_rules_by_id: Option<
        std::collections::HashMap<String, std::collections::HashMap<String, FieldExtractionRule>>,
    >,
    // 新增：用户自定义制卡要求
    #[serde(default)]
    pub custom_requirements: Option<String>,
    // 新增：任务间重叠区域大小控制
    #[serde(default = "default_overlap_size")]
    pub segment_overlap_size: u32,
    // 新增：用户自定义系统 prompt
    #[serde(default)]
    pub system_prompt: Option<String>,

    // ===== CardForge 2.0 多模板支持 =====
    /// 多模板 ID 列表，供 LLM 自动选择最合适的模板
    #[serde(default)]
    pub template_ids: Option<Vec<String>>,

    /// 模板详细描述，供 LLM 理解每个模板的用途和适用场景
    #[serde(default)]
    pub template_descriptions: Option<Vec<TemplateDescription>>,

    /// 是否启用 LLM 智能分段边界检测
    #[serde(default)]
    pub enable_llm_boundary_detection: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiCardGenerationResponse {
    pub success: bool,
    pub cards: Vec<AnkiCard>,
    pub error_message: Option<String>,
}

// 增强的AnkiCard结构体，支持数据库存储和任务关联
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiCard {
    // 🎯 SOTA 修复：front/back 添加 serde(default)，允许从 extra_fields 中获取
    // 这样模板驱动的卡片（如选择题）可以只传 fields 而不需要显式的 front/back
    #[serde(default)]
    pub front: String,
    #[serde(default)]
    pub back: String,
    #[serde(default)]
    pub text: Option<String>, // 新增：用于Cloze填空题模板
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub images: Vec<String>,
    // 新增字段用于数据库存储和内部管理
    #[serde(default = "default_uuid_id")]
    pub id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub is_error_card: bool,
    #[serde(default)]
    pub error_content: Option<String>,
    #[serde(default = "default_timestamp")]
    pub created_at: String,
    #[serde(default = "default_timestamp")]
    pub updated_at: String,
    // 新增：扩展字段支持，用于自定义模板
    #[serde(default)]
    pub extra_fields: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub template_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiLibraryCard {
    #[serde(flatten)]
    pub card: AnkiCard,
    #[serde(rename = "sourceType")]
    pub source_type: Option<String>,
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAnkiCardsRequest {
    pub template_id: Option<String>,
    pub search: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCardListResponse {
    pub items: Vec<AnkiLibraryCard>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAnkiCardsRequest {
    pub ids: Vec<String>,
    pub format: String,
    pub deck_name: Option<String>,
    pub note_type: Option<String>,
    pub template_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAnkiCardsResponse {
    pub file_path: String,
    pub size_bytes: u64,
    pub format: String,
}

// 自定义模板系统相关结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAnkiTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub version: String,
    pub preview_front: String,
    pub preview_back: String,
    pub note_type: String,
    pub fields: Vec<String>,
    pub generation_prompt: String,
    pub front_template: String,
    pub back_template: String,
    pub css_style: String,
    // 字段解析规则：指定如何从AI输出中提取和验证字段
    pub field_extraction_rules: std::collections::HashMap<String, FieldExtractionRule>,
    // 模板元数据
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    pub is_built_in: bool,
    pub preview_data_json: Option<String>,
}

// 验证规则 - 支持SOTA级别的字段验证
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationRule {
    pub pattern: Option<String>,                     // 正则表达式
    pub min: Option<f64>,                            // 最小值（数字或长度）
    pub max: Option<f64>,                            // 最大值（数字或长度）
    pub enum_values: Option<Vec<serde_json::Value>>, // 枚举值
    pub custom: Option<String>,                      // 自定义验证函数名
    pub error_message: Option<String>,               // 自定义错误消息
}

// 转换规则 - 支持字段值的智能转换
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformRule {
    pub transform_type: String,          // 转换类型
    pub format: Option<String>,          // 格式模板
    pub custom_function: Option<String>, // 自定义转换函数
}

// 对象结构定义 - 支持复杂嵌套结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSchema {
    pub properties: std::collections::HashMap<String, FieldExtractionRule>,
    pub required: Option<Vec<String>>,
}

// 增强的字段解析规则 - SOTA级别的字段类型系统
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldExtractionRule {
    pub field_type: FieldType,
    pub is_required: bool,
    pub default_value: Option<String>,
    pub validation_pattern: Option<String>, // 向后兼容：保留旧的验证模式
    pub description: String,

    // 新增SOTA级别功能
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<ValidationRule>, // 增强验证规则
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<TransformRule>, // 转换规则
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<ObjectSchema>, // Object类型的结构定义
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_schema: Option<ObjectSchema>, // ArrayObject的项目结构
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_format: Option<String>, // 显示格式模板
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_hint: Option<String>, // AI生成提示
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>, // 最大长度限制
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>, // 最小长度限制
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_values: Option<Vec<serde_json::Value>>, // 允许的值列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<String>, // 依赖的其他字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_function: Option<String>, // 计算函数（用于Computed类型）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FieldType {
    // Anki 支持的基础类型
    Text,    // 纯文本字段
    Array,   // 数组（会被转换为逗号分隔的文本）
    Number,  // 数字（会被转换为文本）
    Boolean, // 布尔值（会被转换为文本）

    // 保留但会降级为文本的类型
    Date,     // 日期时间（会被格式化为文本）
    RichText, // 富文本（会被转换为纯文本或简单HTML）
    Formula,  // 数学公式（LaTeX格式的文本）

              // 已废弃：Anki 不支持的复杂类型
              // Object,           // 对象类型 - 已移除
              // ArrayObject,      // 对象数组 - 已移除
              // Code,            // 代码块 - 已移除
              // Media,           // 媒体引用 - 已移除
              // Reference,       // 卡片引用 - 已移除
              // Computed         // 计算字段 - 已移除
}

// 模板创建/更新请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub preview_front: String,
    pub preview_back: String,
    pub note_type: String,
    pub fields: Vec<String>,
    pub generation_prompt: String,
    pub front_template: String,
    pub back_template: String,
    pub css_style: String,
    pub field_extraction_rules: std::collections::HashMap<String, FieldExtractionRule>,
    pub preview_data_json: Option<String>,
    pub is_active: Option<bool>,
    pub is_built_in: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTemplateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub expected_version: Option<String>,
    pub preview_front: Option<String>,
    pub preview_back: Option<String>,
    pub note_type: Option<String>,
    pub fields: Option<Vec<String>>,
    pub generation_prompt: Option<String>,
    pub front_template: Option<String>,
    pub back_template: Option<String>,
    pub css_style: Option<String>,
    pub field_extraction_rules: Option<std::collections::HashMap<String, FieldExtractionRule>>,
    pub is_active: Option<bool>,
    pub preview_data_json: Option<String>,
    pub is_built_in: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateImportRequest {
    pub template_data: String, // JSON格式的模板数据
    pub overwrite_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateBulkImportRequest {
    #[serde(alias = "templateData")]
    pub template_data: String, // JSON格式的模板数据（单个或数组）
    #[serde(alias = "overwriteExisting")]
    pub overwrite_existing: bool,
    #[serde(default, alias = "strictBuiltin")]
    pub strict_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateExportResponse {
    pub template_data: String, // JSON格式的模板数据
}

// DocumentTask 结构体 - 支持文档分段任务管理
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentTask {
    pub id: String,                           // UUID
    pub document_id: String,                  // 关联的原始文档ID
    pub original_document_name: String,       // 原始文档名，用于UI显示
    pub segment_index: u32,                   // 在原始文档中的分段序号 (从0开始)
    pub content_segment: String,              // 该任务对应的文档内容片段
    pub status: TaskStatus,                   // 任务状态
    pub created_at: String,                   // ISO8601 格式时间戳
    pub updated_at: String,                   // ISO8601 格式时间戳
    pub error_message: Option<String>,        // 存储任务级别的错误信息
    pub anki_generation_options_json: String, // 存储处理该任务时使用的选项
}

// 任务状态枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskStatus {
    Pending,    // 待处理
    Processing, // 处理中 (AI正在生成卡片)
    Streaming,  // 正在流式返回卡片 (细化Processing状态)
    Paused,     // 已暂停（硬暂停，需手动恢复）
    Completed,  // 处理完成，所有卡片已生成
    Failed,     // 任务处理失败 (例如，AI调用失败，无法分段等)
    Truncated,  // AI输出因达到最大长度等原因被截断
    Cancelled,  // 用户取消
}

impl TaskStatus {
    pub fn to_db_string(&self) -> String {
        match self {
            TaskStatus::Pending => "Pending".to_string(),
            TaskStatus::Processing => "Processing".to_string(),
            TaskStatus::Streaming => "Streaming".to_string(),
            TaskStatus::Paused => "Paused".to_string(),
            TaskStatus::Completed => "Completed".to_string(),
            TaskStatus::Failed => "Failed".to_string(),
            TaskStatus::Truncated => "Truncated".to_string(),
            TaskStatus::Cancelled => "Cancelled".to_string(),
        }
    }

    pub fn from_str(s: &str) -> TaskStatus {
        match s {
            "Pending" => TaskStatus::Pending,
            "Processing" => TaskStatus::Processing,
            "Streaming" => TaskStatus::Streaming,
            "Paused" => TaskStatus::Paused,
            "Completed" => TaskStatus::Completed,
            "Failed" => TaskStatus::Failed,
            "Truncated" => TaskStatus::Truncated,
            "Cancelled" => TaskStatus::Cancelled,
            _ => TaskStatus::Pending, // 默认状态
        }
    }
}

// 流式卡片数据结构
// 🔧 CardForge 2.0 修复：移除 tag/content 属性，使用默认外部标签格式
// 前端期望: { "NewCard": { ... } } 而不是 { "type": "NewCard", "data": { ... } }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamedCardPayload {
    NewCard {
        card: AnkiCard,
        document_id: String,
    }, // 一个新生成的、完整的卡片
    NewErrorCard {
        card: AnkiCard,
        document_id: String,
    }, // 一个新生成的、标识错误的卡片
    TaskStatusUpdate {
        task_id: String,
        status: TaskStatus,
        message: Option<String>,
        segment_index: Option<u32>, // 新增: 用于前端关联临时任务
        document_id: Option<String>,
    }, // 任务状态更新
    TaskProcessingError {
        task_id: String,
        error_message: String,
        document_id: Option<String>,
    }, // 任务处理过程中的严重错误
    TaskCompleted {
        task_id: String,
        final_status: TaskStatus,
        total_cards_generated: u32,
        document_id: Option<String>,
    }, // 单个任务完成信号
    DocumentProcessingStarted {
        document_id: String,
        total_segments: u32,
    }, //整个文档开始处理，告知总任务数
    DocumentProcessingPaused {
        document_id: String,
    }, // 文档处理被暂停
    DocumentProcessingCompleted {
        document_id: String,
    }, // 整个文档所有任务处理完毕
    RateLimitWarning {
        message: String,
        retry_after_seconds: Option<u32>,
    }, // API频率限制警告
    WorkflowFailed {
        workflow_type: String,
        error_message: String,
        fallback_used: bool,
    }, // 工作流失败事件
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub payload: StreamedCardPayload,
}

// 默认值辅助函数
fn default_uuid_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn default_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn default_overlap_size() -> u32 {
    200 // 默认重叠200个字符
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiExportResponse {
    pub success: bool,
    pub file_path: Option<String>,
    pub card_count: i32,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiConnectResult {
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

// 新增：ANKI文档制卡请求结构
#[derive(Debug, Deserialize)]
pub struct AnkiDocumentGenerationRequest {
    pub document_content: String,
    #[serde(default)]
    pub original_document_name: Option<String>,
    pub options: Option<AnkiGenerationOptions>,
}

// 新增：ANKI文档制卡响应结构
#[derive(Debug, Serialize)]
pub struct AnkiDocumentGenerationResponse {
    pub success: bool,
    pub cards: Vec<AnkiCard>,
    pub error_message: Option<String>,
}

// ==================== 智能记忆提取相关 ====================

#[derive(Debug, Deserialize)]
pub struct ExtractMemoriesRequest {
    #[serde(alias = "conversation_id")]
    pub mistake_id: String, // 正式错题ID
    pub chat_history: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryCandidate {
    pub content: String,
    pub category: String, // "概念"/"方法"/"易错点"/"公式"/"技巧"等
}

#[derive(Debug, Serialize)]
pub struct ExtractMemoriesResponse {
    pub success: bool,
    pub candidates: Vec<MemoryCandidate>,
    pub error_message: Option<String>,
}

// ==================== RAG相关数据结构 ====================

// 文档块结构
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DocumentChunk {
    pub id: String,          // UUID for the chunk
    pub document_id: String, // ID of the source document
    pub chunk_index: usize,  // Order of the chunk within the document
    pub text: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>, // e.g., filename, page_number
}

// 带向量的文档块结构
#[derive(Debug, Clone)]
pub struct DocumentChunkWithEmbedding {
    pub chunk: DocumentChunk,
    pub embedding: Vec<f32>,
}

// 检索到的文档块结构
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RetrievedChunk {
    pub chunk: DocumentChunk,
    pub score: f32, // Similarity score
}

// RAG查询选项
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RagQueryOptions {
    pub top_k: usize,
    pub enable_reranking: Option<bool>,
    // pub filters: Option<HashMap<String, String>>, // Future: metadata-based filtering
}

// 知识库状态结构
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KnowledgeBaseStatusPayload {
    pub total_documents: usize,
    pub total_chunks: usize,
    pub embedding_model_name: Option<String>, // Name of the currently used embedding model
    pub vector_store_type: String,
    #[serde(default)]
    pub storage_size_bytes: Option<u64>,
}

// RAG设置结构
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RagSettings {
    pub knowledge_base_path: String, // Path to the vector store / knowledge base files
    pub default_embedding_model_id: Option<String>, // ID of ApiConfig to use for embeddings
    pub default_reranker_model_id: Option<String>, // ID of ApiConfig to use for reranking
    pub default_top_k: usize,
    pub enable_rag_by_default: bool,
}

// RAG增强的分析请求（升级：支持分库）
#[derive(Debug, Deserialize)]
pub struct RagEnhancedAnalysisRequest {
    pub temp_id: String,
    pub enable_chain_of_thought: bool,
    pub enable_rag: Option<bool>,
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub model2_override_id: Option<String>,
}

// RAG增强的对话请求（升级：支持分库）
#[derive(Debug, Deserialize)]
pub struct RagEnhancedChatRequest {
    pub temp_id: String,
    pub chat_history: Vec<ChatMessage>,
    pub enable_chain_of_thought: Option<bool>,
    pub enable_rag: Option<bool>,
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub model2_override_id: Option<String>,
}

// 向量存储统计信息
#[derive(Debug, Clone)]
pub struct VectorStoreStats {
    pub total_documents: usize,
    pub total_chunks: usize,
    pub storage_size_bytes: u64,
}

// 文档上传和处理相关结构
#[derive(Debug, Deserialize)]
pub struct DocumentUploadRequest {
    pub file_paths: Vec<String>,
    pub chunk_size: Option<usize>,
    pub chunk_overlap: Option<usize>,
    pub enable_preprocessing: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct DocumentProcessingStatus {
    pub document_id: String,
    pub file_name: String,
    pub status: DocumentProcessingStage,
    pub progress: f32, // 0.0 to 1.0
    pub error_message: Option<String>,
    pub chunks_processed: usize,
    pub total_chunks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DocumentProcessingStage {
    Pending,
    Reading,
    Preprocessing,
    Chunking,
    Embedding,
    Storing,
    Completed,
    Failed,
}

// RAG查询响应结构
#[derive(Debug, Serialize)]
pub struct RagQueryResponse {
    pub retrieved_chunks: Vec<RetrievedChunk>,
    pub query_vector_time_ms: u64,
    pub search_time_ms: u64,
    pub reranking_time_ms: Option<u64>,
    pub total_time_ms: u64,
}

// RAG配置结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagConfiguration {
    pub id: String,
    pub chunk_size: i32,
    pub chunk_overlap: i32,
    pub chunking_strategy: String, // "fixed_size" or "semantic"
    pub min_chunk_size: i32,
    pub default_top_k: i32,
    pub default_rerank_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// RAG配置请求
#[derive(Debug, Deserialize)]
pub struct RagConfigRequest {
    pub chunk_size: i32,
    pub chunk_overlap: i32,
    pub chunking_strategy: String,
    pub min_chunk_size: i32,
    pub default_top_k: i32,
    pub default_rerank_enabled: bool,
}

// RAG配置响应
#[derive(Debug, Serialize)]
pub struct RagConfigResponse {
    pub chunk_size: i32,
    pub chunk_overlap: i32,
    pub chunking_strategy: String,
    pub min_chunk_size: i32,
    pub default_top_k: i32,
    pub default_rerank_enabled: bool,
}

// ==================== RAG多分库相关数据结构 ====================

/// RAG分库/子库实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubLibrary {
    pub id: String,                  // UUID 主键
    pub name: String,                // 分库名称，用户定义
    pub description: Option<String>, // 可选描述
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub document_count: usize, // 文档数量（查询时计算）
    pub chunk_count: usize,    // 文本块数量（查询时计算）
}

/// 创建分库请求
#[derive(Debug, Deserialize)]
pub struct CreateSubLibraryRequest {
    pub name: String,
    pub description: Option<String>,
}

/// 更新分库请求
#[derive(Debug, Deserialize)]
pub struct UpdateSubLibraryRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// 删除分库选项
#[derive(Debug, Deserialize)]
pub struct DeleteSubLibraryOptions {
    /// 是否删除包含的文档，默认false（移到默认分库）
    pub delete_contained_documents: Option<bool>,
}

/// 带分库信息的文档上传请求
#[derive(Debug, Deserialize)]
pub struct RagAddDocumentsRequest {
    pub file_paths: Vec<String>,
    pub sub_library_id: Option<String>, // 目标分库ID，None为默认分库
}

/// 带分库信息的Base64文档上传请求
#[derive(Debug, Deserialize)]
pub struct RagAddDocumentsFromContentRequest {
    pub documents: Vec<RagDocumentContent>,
    pub sub_library_id: Option<String>, // 目标分库ID，None为默认分库
}

/// RAG文档内容
#[derive(Debug, Deserialize)]
pub struct RagDocumentContent {
    pub file_name: String,
    pub base64_content: String,
    /// 🔧 修复：添加metadata字段以支持智能记忆来源标识
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 带分库过滤的RAG查询选项
#[derive(Debug, Deserialize, Clone)]
pub struct RagQueryOptionsWithLibraries {
    pub top_k: usize,
    pub enable_reranking: Option<bool>,
    pub target_sub_library_ids: Option<Vec<String>>, // 目标分库ID列表，None表示查询所有分库
}

/// 获取文档列表请求
#[derive(Debug, Deserialize)]
pub struct GetDocumentsRequest {
    pub sub_library_id: Option<String>, // 分库ID过滤，None表示获取所有文档
    pub page: Option<usize>,            // 分页页码
    pub page_size: Option<usize>,       // 每页大小
}

/// RAG增强的分析请求（带分库支持）
#[derive(Debug, Deserialize)]
pub struct RagEnhancedAnalysisRequestWithLibraries {
    pub temp_id: String,
    pub enable_chain_of_thought: bool,
    pub enable_rag: Option<bool>,
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
}

/// RAG增强的对话请求（带分库支持）
#[derive(Debug, Deserialize)]
pub struct RagEnhancedChatRequestWithLibraries {
    pub temp_id: String,
    pub chat_history: Vec<ChatMessage>,
    pub enable_chain_of_thought: Option<bool>,
    pub enable_rag: Option<bool>,
    pub rag_options: Option<RagQueryOptionsWithLibraries>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionListRequest {
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionListResponse {
    pub sessions: Vec<ExamSheetSessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionDetailRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionDetailResponse {
    pub detail: ExamSheetSessionDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionLinkRequest {
    pub session_id: String,
    #[serde(default)]
    pub mistake_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionLinkResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionUnlinkRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    pub mistake_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamSheetSessionUnlinkResponse {
    pub detail: ExamSheetSessionDetail,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_generation_model_assignment_defaults_for_legacy_payload() {
        let assignments: ModelAssignments = serde_json::from_str(
            r#"{"model2_config_id":null,"review_analysis_model_config_id":null}"#,
        )
        .unwrap();

        assert!(assignments.image_generation_model_config_id.is_none());
    }
}
