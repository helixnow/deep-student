//! 内容块类型（跨模块共用）。
//!
//! `ContentBlock` 是资源内容格式化后的最小单元，chat_v2 与 dstu 导出链路都要用。
//! 它只依赖 serde，因此放在 dstu-core；chat_v2 按原路径
//! `crate::chat_v2::resource_types::ContentBlock` 重导出。

use serde::{Deserialize, Serialize};

/// 内容块（兼容 OpenAI/Anthropic/Gemini）
///
/// 用于格式化资源内容，支持文本和图片两种类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    /// 文本内容块
    Text {
        /// 文本内容
        text: String,
    },
    /// 图片内容块
    Image {
        /// MIME 类型（如 image/png, image/jpeg）
        #[serde(rename = "mediaType")]
        media_type: String,
        /// Base64 编码的图片数据
        base64: String,
    },
}

impl ContentBlock {
    /// 创建文本内容块
    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text { text: text.into() }
    }

    /// 创建图片内容块
    pub fn image(media_type: impl Into<String>, base64: impl Into<String>) -> Self {
        ContentBlock::Image {
            media_type: media_type.into(),
            base64: base64.into(),
        }
    }
}
