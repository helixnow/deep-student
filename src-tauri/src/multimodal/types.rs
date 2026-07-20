//! 多模态知识库类型定义
//!
//! 本模块定义了多模态 RAG 系统仍在使用的核心数据类型：
//! - `MultimodalInput` / `MultimodalImage` / `MultimodalVideo`: 统一的多模态输入表示
//! - `VLEmbeddingInputItem` / `VLRerankerResult`: llm_manager 的 API 请求/响应类型
//! - `MultimodalIndexingMode`: 索引模式（方案二已弃用，见 embedding_service）
//! - `IndexProgressEvent`: VFS 索引进度事件（vfs/handlers、vfs/multimodal_service 依赖）
//!
//! ★ 2026-07-19 死类型清理（全仓 grep 确认无引用后删除，前端 TS 侧为独立定义不受影响）：
//! - `SourceType` / `PageEmbeddingMetadata`（mm_indexed_pages_json 实际由
//!   vfs/multimodal_service 以 ad-hoc JSON 写入，与该类型 schema 早已不一致）
//! - `MultimodalRetrievalResult` / `RetrievalSource` / `MultimodalRetrievalConfig`
//! - `DimensionRegistry`（此前已标 DEPRECATED，由 VfsEmbeddingDim 替代）
//! - `PageIndexTask` / `PageIndexLog` / `IndexResult` / `VLRerankerRequest`
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md

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
/// - **VLEmbedding**: 直接使用 VL-Embedding 模型（如 Qwen3-VL-Embedding）对图片进行多模态向量化。
///   当前唯一存活的模式。
/// - **VLSummaryThenTextEmbed**: ⚠️ 已弃用。先用 VL 模型生成图片摘要，再用文本嵌入模型向量化。
///   `MultimodalEmbeddingService::is_mode_available` 对该模式恒返回 false，VFS 索引编排不再调用；
///   枚举值保留仅为兼容历史序列化数据（mm_indexing_mode 字段）。
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

    /// 方案二：VL 摘要 + 文本嵌入（已弃用，仅保留序列化兼容）
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
// 索引进度事件
// ============================================================================

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
    fn test_vl_embedding_input_conversion() {
        let input = MultimodalInput::text_and_image("Test", "abc123", "image/png");
        let api_input: VLEmbeddingInputItem = (&input).into();
        assert_eq!(api_input.text, Some("Test".to_string()));
        assert_eq!(
            api_input.image,
            Some("data:image/png;base64,abc123".to_string())
        );
    }

    #[test]
    fn test_indexing_mode_roundtrip() {
        assert_eq!(
            MultimodalIndexingMode::from_str("vl_embedding"),
            Some(MultimodalIndexingMode::VLEmbedding)
        );
        assert_eq!(
            MultimodalIndexingMode::from_str("vl-summary-then-text-embed"),
            Some(MultimodalIndexingMode::VLSummaryThenTextEmbed)
        );
        assert_eq!(MultimodalIndexingMode::VLEmbedding.as_str(), "vl_embedding");
        assert_eq!(MultimodalIndexingMode::default().vector_table_suffix(), "vl");
    }
}
