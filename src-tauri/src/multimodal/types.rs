//! 多模态知识库类型定义
//!
//! 本模块定义了多模态 RAG 系统的核心数据类型，包括：
//! - MultimodalInput: 统一的多模态输入表示
//! - MultimodalRetrievalResult: 检索结果类型
//! - PageEmbeddingMetadata: 页面嵌入元数据
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ============================================================================
// 多模态输入类型
// ============================================================================

/// 多模态输入内容
///
/// 支持以下四种模式：
/// 1. 纯文本: 仅包含 text
/// 2. 纯图片: 仅包含 image
/// 3. 图文混合: 同时包含 text 和 image
/// 4. 视频: 预留扩展（未来支持）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultimodalInput {
    /// 文本内容（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    /// 图片内容（可选）
    /// 支持 Base64 编码或 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<MultimodalImage>,

    /// 任务指令（可选）
    /// 用于优化特定场景的检索效果，官方建议使用英文指令
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,

    /// 视频内容（可选，预留扩展）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<MultimodalVideo>,
}

impl MultimodalInput {
    /// 创建纯文本输入
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            image: None,
            instruction: None,
            video: None,
        }
    }

    /// 创建纯图片输入（Base64）
    pub fn image_base64(base64: impl Into<String>, media_type: impl Into<String>) -> Self {
        Self {
            text: None,
            image: Some(MultimodalImage::Base64 {
                data: base64.into(),
                media_type: media_type.into(),
            }),
            instruction: None,
            video: None,
        }
    }

    /// 创建纯图片输入（URL）
    pub fn image_url(url: impl Into<String>) -> Self {
        Self {
            text: None,
            image: Some(MultimodalImage::Url { url: url.into() }),
            instruction: None,
            video: None,
        }
    }

    /// 创建图文混合输入
    pub fn text_and_image(
        text: impl Into<String>,
        base64: impl Into<String>,
        media_type: impl Into<String>,
    ) -> Self {
        Self {
            text: Some(text.into()),
            image: Some(MultimodalImage::Base64 {
                data: base64.into(),
                media_type: media_type.into(),
            }),
            instruction: None,
            video: None,
        }
    }

    /// 设置任务指令
    pub fn with_instruction(mut self, instruction: impl Into<String>) -> Self {
        self.instruction = Some(instruction.into());
        self
    }

    /// 判断是否为纯文本
    pub fn is_text_only(&self) -> bool {
        self.text.is_some() && self.image.is_none() && self.video.is_none()
    }

    /// 判断是否包含图片
    pub fn has_image(&self) -> bool {
        self.image.is_some()
    }

    /// 判断是否为空
    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.image.is_none() && self.video.is_none()
    }
}

/// 多模态图片内容
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MultimodalImage {
    /// Base64 编码的图片
    Base64 {
        /// Base64 编码的图片数据（不含 data: 前缀）
        data: String,
        /// MIME 类型（如 image/png, image/jpeg）
        media_type: String,
    },
    /// URL 引用的图片
    Url {
        /// 图片 URL
        url: String,
    },
}

impl MultimodalImage {
    /// 获取 Base64 数据（如果是 Base64 类型）
    pub fn as_base64(&self) -> Option<(&str, &str)> {
        match self {
            MultimodalImage::Base64 { data, media_type } => Some((data, media_type)),
            MultimodalImage::Url { .. } => None,
        }
    }

    /// 获取 URL（如果是 URL 类型）
    pub fn as_url(&self) -> Option<&str> {
        match self {
            MultimodalImage::Base64 { .. } => None,
            MultimodalImage::Url { url } => Some(url),
        }
    }
}

/// 多模态视频内容（预留扩展）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MultimodalVideo {
    /// URL 引用的视频
    Url { url: String },
    /// 帧序列
    Frames {
        frames: Vec<MultimodalImage>,
        fps: f32,
    },
}

// ============================================================================
// 资源来源类型
// ============================================================================

/// 多模态资源来源类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    /// PDF 附件
    Attachment,
    /// 题目集识别
    Exam,
    /// 教材
    Textbook,
    /// 笔记
    Note,
    /// 独立图片
    Image,
}

impl SourceType {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "attachment" => Some(Self::Attachment),
            "exam" => Some(Self::Exam),
            "textbook" => Some(Self::Textbook),
            "note" => Some(Self::Note),
            "image" => Some(Self::Image),
            _ => None,
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Attachment => "attachment",
            Self::Exam => "exam",
            Self::Textbook => "textbook",
            Self::Note => "note",
            Self::Image => "image",
        }
    }
}

impl std::fmt::Display for SourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// ============================================================================
// 页面嵌入元数据
// ============================================================================

/// 页面嵌入元数据
///
/// 存储在 VFS textbooks.mm_indexed_pages_json 中，用于追踪索引状态和支持增量更新
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageEmbeddingMetadata {
    /// 页面嵌入记录的唯一标识（格式 page_{nanoid}）
    pub id: String,

    /// 来源类型
    pub source_type: SourceType,

    /// 来源资源 ID
    pub source_id: String,

    /// 页码（0-based）
    pub page_index: i32,

    /// 页面图片的 Blob 哈希（用于增量检测）
    pub blob_hash: String,

    /// VLM 摘要或 OCR 文本
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_summary: Option<String>,

    /// 向量维度
    pub embedding_dim: i32,

    /// 嵌入模型版本
    pub embedding_version: String,

    /// 创建时间
    pub created_at: DateTime<Utc>,

    /// 更新时间
    pub updated_at: DateTime<Utc>,
}

impl PageEmbeddingMetadata {
    /// 创建新的页面嵌入元数据
    pub fn new(
        source_type: SourceType,
        source_id: impl Into<String>,
        page_index: i32,
        blob_hash: impl Into<String>,
        embedding_dim: i32,
        embedding_version: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: format!("page_{}", nanoid::nanoid!(12)),
            source_type,
            source_id: source_id.into(),
            page_index,
            blob_hash: blob_hash.into(),
            text_summary: None,
            embedding_dim,
            embedding_version: embedding_version.into(),
            created_at: now,
            updated_at: now,
        }
    }

    /// 设置文本摘要
    pub fn with_text_summary(mut self, text: impl Into<String>) -> Self {
        self.text_summary = Some(text.into());
        self
    }
}

// ============================================================================
// 检索结果类型
// ============================================================================

/// 检索结果来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalSource {
    /// 多模态页面向量表
    MultimodalPage,
    /// 文本块向量表
    TextChunk,
}

/// 多模态检索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultimodalRetrievalResult {
    /// 结果唯一标识
    pub id: String,

    /// 来源类型
    pub source_type: SourceType,

    /// 来源资源 ID
    pub source_id: String,

    /// 页码索引（多模态页面）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_index: Option<i32>,

    /// 块索引（文本块）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_index: Option<i32>,

    /// 文本内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,

    /// 图片 Base64 数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_base64: Option<String>,

    /// 图片 MIME 类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_media_type: Option<String>,

    /// Blob 哈希（用于加载原图）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,

    /// 相关性分数
    pub score: f32,

    /// 结果来源（多模态页面 / 文本块）
    pub retrieval_source: RetrievalSource,

    /// 额外元数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl MultimodalRetrievalResult {
    /// 创建多模态页面检索结果
    pub fn from_page(
        source_type: SourceType,
        source_id: impl Into<String>,
        page_index: i32,
        score: f32,
    ) -> Self {
        Self {
            id: format!("result_{}", nanoid::nanoid!(8)),
            source_type,
            source_id: source_id.into(),
            page_index: Some(page_index),
            chunk_index: None,
            text_content: None,
            image_base64: None,
            image_media_type: None,
            blob_hash: None,
            score,
            retrieval_source: RetrievalSource::MultimodalPage,
            metadata: None,
        }
    }

    /// 创建文本块检索结果
    pub fn from_chunk(
        source_type: SourceType,
        source_id: impl Into<String>,
        chunk_index: i32,
        text_content: impl Into<String>,
        score: f32,
    ) -> Self {
        Self {
            id: format!("result_{}", nanoid::nanoid!(8)),
            source_type,
            source_id: source_id.into(),
            page_index: None,
            chunk_index: Some(chunk_index),
            text_content: Some(text_content.into()),
            image_base64: None,
            image_media_type: None,
            blob_hash: None,
            score,
            retrieval_source: RetrievalSource::TextChunk,
            metadata: None,
        }
    }

    /// 设置图片内容
    pub fn with_image(mut self, base64: impl Into<String>, media_type: impl Into<String>) -> Self {
        self.image_base64 = Some(base64.into());
        self.image_media_type = Some(media_type.into());
        self
    }

    /// 设置 Blob 哈希
    pub fn with_blob_hash(mut self, hash: impl Into<String>) -> Self {
        self.blob_hash = Some(hash.into());
        self
    }

    /// 设置文本内容
    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text_content = Some(text.into());
        self
    }

    /// 设置元数据
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

// ============================================================================
// 嵌入维度注册
// ============================================================================

/// 嵌入维度注册信息
///
/// ⚠️ DEPRECATED: 已迁移到 `crate::vfs::repos::embedding_dim_repo::VfsEmbeddingDim`
/// 保留仅为类型兼容，不再有运行时调用方。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionRegistry {
    /// 向量维度
    pub dimension: i32,

    /// 对应的模型配置 ID（关联 api_configs.id）
    pub model_config_id: String,

    /// 模型名称（用于 UI 显示）
    pub model_name: String,

    /// 表前缀（kb_chunks / mm_pages）
    pub table_prefix: String,

    /// 是否为多模态模型
    pub is_multimodal: bool,

    /// 首次注册时间
    pub created_at: DateTime<Utc>,

    /// 最后更新时间
    pub updated_at: DateTime<Utc>,
}

impl DimensionRegistry {
    /// 创建新的维度注册
    pub fn new(
        dimension: i32,
        model_config_id: impl Into<String>,
        model_name: impl Into<String>,
        table_prefix: impl Into<String>,
        is_multimodal: bool,
    ) -> Self {
        let now = Utc::now();
        Self {
            dimension,
            model_config_id: model_config_id.into(),
            model_name: model_name.into(),
            table_prefix: table_prefix.into(),
            is_multimodal,
            created_at: now,
            updated_at: now,
        }
    }
}

// ============================================================================
// 检索配置
// ============================================================================

/// 多模态检索配置参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultimodalRetrievalConfig {
    /// 多模态召回数量
    #[serde(default = "default_mm_top_k")]
    pub mm_top_k: usize,

    /// 文本召回数量
    #[serde(default = "default_text_top_k")]
    pub text_top_k: usize,

    /// 融合后保留数量
    #[serde(default = "default_merge_top_k")]
    pub merge_top_k: usize,

    /// 最终返回数量
    #[serde(default = "default_final_top_k")]
    pub final_top_k: usize,

    /// 是否启用精排
    #[serde(default = "default_enable_reranking")]
    pub enable_reranking: bool,

    /// 知识库过滤
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_library_ids: Option<Vec<String>>,
}

fn default_mm_top_k() -> usize {
    20
}
fn default_text_top_k() -> usize {
    20
}
fn default_merge_top_k() -> usize {
    30
}
fn default_final_top_k() -> usize {
    10
}
fn default_enable_reranking() -> bool {
    true
}

impl Default for MultimodalRetrievalConfig {
    fn default() -> Self {
        Self {
            mm_top_k: default_mm_top_k(),
            text_top_k: default_text_top_k(),
            merge_top_k: default_merge_top_k(),
            final_top_k: default_final_top_k(),
            enable_reranking: default_enable_reranking(),
            sub_library_ids: None,
        }
    }
}

// ============================================================================
// API 请求/响应类型
// ============================================================================

/// VL-Embedding API 请求中的输入项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VLEmbeddingInputItem {
    /// 文本内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    /// 图片 URL 或 Base64
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// 任务指令
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

impl From<&MultimodalInput> for VLEmbeddingInputItem {
    fn from(input: &MultimodalInput) -> Self {
        let image = input.image.as_ref().map(|img| match img {
            MultimodalImage::Base64 { data, media_type } => {
                format!("data:{};base64,{}", media_type, data)
            }
            MultimodalImage::Url { url } => url.clone(),
        });

        Self {
            text: input.text.clone(),
            image,
            instruction: input.instruction.clone(),
        }
    }
}

/// VL-Reranker API 请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VLRerankerRequest {
    /// 查询内容
    pub query: VLEmbeddingInputItem,

    /// 候选文档列表
    pub documents: Vec<VLEmbeddingInputItem>,

    /// 任务指令
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

/// VL-Reranker API 响应中的单个结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VLRerankerResult {
    /// 文档索引
    pub index: usize,

    /// 相关性分数
    pub relevance_score: f32,
}

// ============================================================================
// 多模态索引模式
// ============================================================================

/// 多模态向量化模式
///
/// 支持两种向量化方案：
/// - **VLEmbedding**: 直接使用 VL-Embedding 模型（如 Qwen3-VL-Embedding）对图片进行多模态向量化
/// - **VLSummaryThenTextEmbed**: 先用 VL 模型生成图片摘要，再用文本嵌入模型向量化
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MultimodalIndexingMode {
    /// 方案一：直接多模态嵌入
    ///
    /// 使用 Qwen3-VL-Embedding 等多模态嵌入模型，直接对页面图片进行向量化。
    /// 优点：保留完整视觉信息，适合图表、公式等视觉密集内容
    /// 缺点：需要专用的多模态嵌入模型
    #[default]
    VLEmbedding,

    /// 方案二：VL 摘要 + 文本嵌入
    ///
    /// 1. 使用 VL 模型（如 Qwen-VL）阅读图片，生成结构化文本摘要
    /// 2. 使用文本嵌入模型（如 BGE）对摘要进行向量化
    /// 优点：可复用现有文本嵌入模型，成本更低
    /// 缺点：摘要过程可能丢失部分视觉细节
    VLSummaryThenTextEmbed,
}

impl MultimodalIndexingMode {
    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().replace('-', "_").as_str() {
            "vl_embedding" | "vlembedding" | "direct" => Some(Self::VLEmbedding),
            "vl_summary_then_text_embed" | "vlsummarythentextembed" | "summary" => {
                Some(Self::VLSummaryThenTextEmbed)
            }
            _ => None,
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::VLEmbedding => "vl_embedding",
            Self::VLSummaryThenTextEmbed => "vl_summary_then_text_embed",
        }
    }

    /// 是否需要多模态嵌入模型
    pub fn requires_vl_embedding_model(&self) -> bool {
        matches!(self, Self::VLEmbedding)
    }

    /// 是否需要 VL 摘要模型
    pub fn requires_vl_summary_model(&self) -> bool {
        matches!(self, Self::VLSummaryThenTextEmbed)
    }

    /// 是否需要文本嵌入模型
    pub fn requires_text_embedding_model(&self) -> bool {
        matches!(self, Self::VLSummaryThenTextEmbed)
    }

    /// 获取向量表类型后缀
    ///
    /// 用于区分多模态向量和文本向量，即使维度相同也分开存储
    /// - VLEmbedding → "vl" (多模态向量)
    /// - VLSummaryThenTextEmbed → "text" (文本向量)
    pub fn vector_table_suffix(&self) -> &'static str {
        match self {
            Self::VLEmbedding => "vl",
            Self::VLSummaryThenTextEmbed => "text",
        }
    }
}

impl std::fmt::Display for MultimodalIndexingMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// ============================================================================
// 索引任务类型
// ============================================================================

/// 页面索引任务
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageIndexTask {
    /// 来源类型
    pub source_type: SourceType,

    /// 来源资源 ID
    pub source_id: String,

    /// 所属知识库 ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_library_id: Option<String>,

    /// 强制重建（忽略增量检测）
    #[serde(default)]
    pub force_rebuild: bool,

    /// 索引模式（默认使用 VL-Embedding 直接向量化）
    #[serde(default)]
    pub indexing_mode: MultimodalIndexingMode,
}

/// 索引进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressEvent {
    /// 来源类型
    pub source_type: String,
    /// 来源 ID
    pub source_id: String,
    /// 当前阶段：preparing/embedding/saving/completed/failed
    pub phase: String,
    /// 当前处理的页码（从 1 开始）
    pub current_page: i32,
    /// 总页数
    pub total_pages: i32,
    /// 已成功索引的页数
    pub indexed_pages: i32,
    /// 已跳过的页数（增量索引时未变化的页面）
    pub skipped_pages: i32,
    /// 进度百分比 (0-100)
    pub progress_percent: i32,
    /// 当前状态消息
    pub message: String,
}

impl IndexProgressEvent {
    pub fn new(source_type: &str, source_id: &str, total_pages: i32) -> Self {
        Self {
            source_type: source_type.to_string(),
            source_id: source_id.to_string(),
            phase: "preparing".to_string(),
            current_page: 0,
            total_pages,
            indexed_pages: 0,
            skipped_pages: 0,
            progress_percent: 0,
            message: "准备中...".to_string(),
        }
    }

    pub fn with_phase(mut self, phase: &str, message: &str) -> Self {
        self.phase = phase.to_string();
        self.message = message.to_string();
        self
    }

    pub fn with_progress(mut self, current: i32, indexed: i32, skipped: i32) -> Self {
        self.current_page = current;
        self.indexed_pages = indexed;
        self.skipped_pages = skipped;
        if self.total_pages > 0 {
            self.progress_percent = ((current as f64 / self.total_pages as f64) * 100.0) as i32;
        }
        self
    }
}

/// 单页索引日志（用于调试和用户反馈）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageIndexLog {
    /// 页码索引（0-based）
    pub page_index: i32,
    /// 索引状态：success / failed / skipped
    pub status: String,
    /// 摘要预览（截取前80字符）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_preview: Option<String>,
    /// 嵌入维度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_dim: Option<usize>,
    /// 错误信息（如果失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 处理耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl PageIndexLog {
    /// 创建成功日志
    pub fn success(
        page_index: i32,
        summary: Option<&str>,
        embedding_dim: usize,
        duration_ms: u64,
    ) -> Self {
        Self {
            page_index,
            status: "success".to_string(),
            summary_preview: summary.map(|s| truncate_str(s, 80)),
            embedding_dim: Some(embedding_dim),
            error: None,
            duration_ms: Some(duration_ms),
        }
    }

    /// 创建失败日志
    pub fn failed(page_index: i32, error: impl Into<String>) -> Self {
        Self {
            page_index,
            status: "failed".to_string(),
            summary_preview: None,
            embedding_dim: None,
            error: Some(error.into()),
            duration_ms: None,
        }
    }

    /// 创建跳过日志
    pub fn skipped(page_index: i32, reason: impl Into<String>) -> Self {
        Self {
            page_index,
            status: "skipped".to_string(),
            summary_preview: None,
            embedding_dim: None,
            error: Some(reason.into()),
            duration_ms: None,
        }
    }
}

/// 截取字符串到指定长度（按字符边界安全截取）
fn truncate_str(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = chars[..max_chars].iter().collect();
        format!("{}...", truncated)
    }
}

/// 索引结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    /// 成功索引的页数
    pub indexed_pages: i32,

    /// 跳过的页数（已存在且未变化）
    pub skipped_pages: i32,

    /// 失败的页数
    pub failed_pages: i32,

    /// 总页数
    pub total_pages: i32,

    /// 错误信息（如果有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,

    /// 每页索引日志（用于详细调试）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_logs: Option<Vec<PageIndexLog>>,
}

impl IndexResult {
    /// 创建成功结果
    pub fn success(indexed: i32, skipped: i32, total: i32) -> Self {
        Self {
            indexed_pages: indexed,
            skipped_pages: skipped,
            failed_pages: 0,
            total_pages: total,
            error_message: None,
            page_logs: None,
        }
    }

    /// 创建带日志的结果
    pub fn with_logs(
        indexed: i32,
        skipped: i32,
        failed: i32,
        total: i32,
        logs: Vec<PageIndexLog>,
    ) -> Self {
        Self {
            indexed_pages: indexed,
            skipped_pages: skipped,
            failed_pages: failed,
            total_pages: total,
            error_message: None,
            page_logs: Some(logs),
        }
    }

    /// 创建失败结果
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            indexed_pages: 0,
            skipped_pages: 0,
            failed_pages: 0,
            total_pages: 0,
            error_message: Some(error.into()),
            page_logs: None,
        }
    }

    /// 生成可读的日志摘要（用于复制给开发者）
    pub fn to_log_summary(&self) -> String {
        let mut lines = Vec::new();
        lines.push(format!(
            "📊 索引结果: 成功={}, 跳过={}, 失败={}, 总计={}",
            self.indexed_pages, self.skipped_pages, self.failed_pages, self.total_pages
        ));

        if let Some(ref logs) = self.page_logs {
            for log in logs {
                let status_icon = match log.status.as_str() {
                    "success" => "✅",
                    "failed" => "❌",
                    "skipped" => "⏭️",
                    _ => "❓",
                };
                let mut line = format!("  {} P{}", status_icon, log.page_index + 1);
                if let Some(ref preview) = log.summary_preview {
                    line.push_str(&format!(" | {}", preview));
                }
                if let Some(dim) = log.embedding_dim {
                    line.push_str(&format!(" | dim={}", dim));
                }
                if let Some(ref err) = log.error {
                    line.push_str(&format!(" | err={}", err));
                }
                if let Some(ms) = log.duration_ms {
                    line.push_str(&format!(" | {}ms", ms));
                }
                lines.push(line);
            }
        }

        if let Some(ref err) = self.error_message {
            lines.push(format!("❌ 错误: {}", err));
        }

        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_multimodal_input_text_only() {
        let input = MultimodalInput::text("Hello world");
        assert!(input.is_text_only());
        assert!(!input.has_image());
        assert!(!input.is_empty());
        assert_eq!(input.text.as_deref(), Some("Hello world"));
    }

    #[test]
    fn test_multimodal_input_image_only() {
        let input = MultimodalInput::image_base64("base64data", "image/png");
        assert!(!input.is_text_only());
        assert!(input.has_image());
        assert!(!input.is_empty());
    }

    #[test]
    fn test_multimodal_input_mixed() {
        let input = MultimodalInput::text_and_image("Description", "base64data", "image/jpeg");
        assert!(!input.is_text_only());
        assert!(input.has_image());
        assert_eq!(input.text.as_deref(), Some("Description"));
    }

    #[test]
    fn test_multimodal_input_with_instruction() {
        let input = MultimodalInput::text("Query").with_instruction("Represent the query");
        assert_eq!(input.instruction.as_deref(), Some("Represent the query"));
    }

    #[test]
    fn test_source_type_conversion() {
        assert_eq!(
            SourceType::from_str("attachment"),
            Some(SourceType::Attachment)
        );
        assert_eq!(SourceType::from_str("EXAM"), Some(SourceType::Exam));
        assert_eq!(SourceType::Attachment.as_str(), "attachment");
    }

    #[test]
    fn test_retrieval_result_from_page() {
        let result = MultimodalRetrievalResult::from_page(SourceType::Exam, "exam_123", 0, 0.95);
        assert_eq!(result.source_type, SourceType::Exam);
        assert_eq!(result.page_index, Some(0));
        assert_eq!(result.retrieval_source, RetrievalSource::MultimodalPage);
    }

    #[test]
    fn test_retrieval_result_from_chunk() {
        let result = MultimodalRetrievalResult::from_chunk(
            SourceType::Attachment,
            "doc_456",
            5,
            "Some text content",
            0.88,
        );
        assert_eq!(result.chunk_index, Some(5));
        assert_eq!(result.retrieval_source, RetrievalSource::TextChunk);
    }

    #[test]
    fn test_vl_embedding_input_conversion() {
        let input = MultimodalInput::text_and_image("Test", "abc123", "image/png");
        let api_input: VLEmbeddingInputItem = (&input).into();
        assert_eq!(api_input.text, Some("Test".to_string()));
        assert_eq!(
            api_input.image,
            Some("data:image/png;base64,abc123".to_string())
        );
    }
}
