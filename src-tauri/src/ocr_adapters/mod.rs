//! OCR 适配器模块
//!
//! 提供可扩展的 OCR 适配器架构，支持多种 OCR 引擎：
//! - DeepSeek-OCR：支持 grounding 坐标输出
//! - PaddleOCR-VL：百度开源 OCR 视觉语言模型
//! - 通用 VLM：使用标准多模态模型进行 OCR
//!
//! ## 架构设计
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │                     OcrAdapter trait                         │
//! ├─────────────────────────────────────────────────────────────┤
//! │  + build_prompt(&self, mode) -> String                      │
//! │  + parse_response(&self, resp, img_size) -> OcrPageResult   │
//! │  + engine_type(&self) -> OcrEngineType                      │
//! │  + supports_mode(&self, mode) -> bool                       │
//! └─────────────────────────────────────────────────────────────┘
//!            ▲                              ▲
//!            │                              │
//! ┌──────────┴──────────┐      ┌───────────┴───────────┐
//! │  DeepSeekOcrAdapter │      │  PaddleOcrVlAdapter   │
//! ├─────────────────────┤      ├─────────────────────────┤
//! │ • grounding prompt  │      │ • standard prompt       │
//! │ • 0-999 坐标解析    │      │ • 像素坐标/Markdown    │
//! │ • ref/det 标记解析  │      │ • 版面检测+识别        │
//! └─────────────────────┘      └─────────────────────────┘
//! ```
//!
//! ## 使用示例
//!
//! ```rust,ignore
//! use crate::ocr_adapters::{OcrAdapterFactory, OcrEngineType, OcrMode};
//!
//! // 创建适配器
//! let adapter = OcrAdapterFactory::create(OcrEngineType::DeepSeekOcr);
//!
//! // 构建 prompt
//! let prompt = adapter.build_prompt(OcrMode::Grounding);
//!
//! // 解析响应
//! let result = adapter.parse_response(&response_text, 1920, 1080, 0)?;
//! ```

mod deepseek;
mod factory;
mod paddle;
pub mod system_ocr;
pub mod types;

// 重新导出核心类型
pub use deepseek::DeepSeekOcrAdapter;
pub use factory::OcrAdapterFactory;
pub use paddle::PaddleOcrVlAdapter;
pub use system_ocr::SystemOcrAdapter;
pub use types::*;

use async_trait::async_trait;

/// OCR 适配器 trait
///
/// 所有 OCR 引擎适配器必须实现此 trait，以确保统一的接口。
#[async_trait]
pub trait OcrAdapter: Send + Sync {
    /// 获取引擎类型
    fn engine_type(&self) -> OcrEngineType;

    /// 获取引擎显示名称
    fn display_name(&self) -> &'static str {
        self.engine_type().display_name()
    }

    /// 检查是否支持指定模式
    fn supports_mode(&self, mode: OcrMode) -> bool;

    /// 构建 OCR prompt
    ///
    /// 根据引擎类型和识别模式，构建适合该引擎的 prompt。
    fn build_prompt(&self, mode: OcrMode) -> String;

    /// 构建自定义 prompt（可选）
    ///
    /// 允许用户提供自定义 prompt，适配器会进行必要的格式转换。
    fn build_custom_prompt(&self, custom_prompt: &str, _mode: OcrMode) -> String {
        // 默认实现：直接使用自定义 prompt
        custom_prompt.to_string()
    }

    /// 解析 OCR 响应
    ///
    /// 将模型返回的原始文本解析为统一的 `OcrPageResult` 结构。
    ///
    /// # 参数
    /// - `response`: 模型返回的原始响应文本
    /// - `image_width`: 原始图片宽度（像素）
    /// - `image_height`: 原始图片高度（像素）
    /// - `page_index`: 页面索引
    /// - `image_path`: 图片路径
    /// - `mode`: 使用的识别模式
    ///
    /// # 返回
    /// 解析后的页面结果，包含识别到的文本区域
    fn parse_response(
        &self,
        response: &str,
        image_width: u32,
        image_height: u32,
        page_index: usize,
        image_path: &str,
        mode: OcrMode,
    ) -> Result<OcrPageResult, OcrError>;

    /// 获取推荐的最大输出 token 数
    fn recommended_max_tokens(&self, mode: OcrMode) -> u32 {
        match mode {
            OcrMode::Grounding => 8000,
            OcrMode::FreeOcr => 4096,
            OcrMode::Formula | OcrMode::Table | OcrMode::Chart => 4096,
        }
    }

    /// 获取推荐的温度参数
    fn recommended_temperature(&self) -> f32 {
        0.0 // OCR 任务通常需要确定性输出
    }

    /// 是否需要高清图片模式
    fn requires_high_detail(&self) -> bool {
        true // 默认使用高清模式以获得更好的识别效果
    }

    /// 获取引擎特定的请求参数
    ///
    /// 返回需要添加到 API 请求中的额外参数（JSON 格式）。
    fn get_extra_request_params(&self) -> Option<serde_json::Value> {
        None
    }

    /// 获取推荐的 repetition_penalty 参数
    ///
    /// 某些模型（如 PaddleOCR-VL）需要设置此参数来避免重复输出。
    /// 返回 None 表示不需要设置此参数。
    fn recommended_repetition_penalty(&self) -> Option<f64> {
        None
    }
}

/// 通用 VLM 适配器（简单实现）
///
/// 用于不支持特殊 OCR 功能的通用多模态模型。
pub struct GenericVlmAdapter;

impl GenericVlmAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl OcrAdapter for GenericVlmAdapter {
    fn engine_type(&self) -> OcrEngineType {
        OcrEngineType::GenericVlm
    }

    fn supports_mode(&self, mode: OcrMode) -> bool {
        // L4 fix: 通用 VLM 不支持 Grounding 坐标输出（会降级为纯文本）
        !matches!(mode, OcrMode::Grounding)
    }

    fn build_prompt(&self, mode: OcrMode) -> String {
        // 通用 VLM 不支持坐标输出，所有模式都使用纯文本 prompt
        match mode {
            OcrMode::FreeOcr | OcrMode::Grounding => {
                // Grounding 模式降级为纯文本
                "Convert the document to markdown. Preserve the structure and formatting as much as possible.".to_string()
            }
            OcrMode::Formula => {
                "Extract and convert all mathematical formulas in the image to LaTeX format."
                    .to_string()
            }
            OcrMode::Table => {
                "Extract the table from the image and convert it to markdown table format."
                    .to_string()
            }
            OcrMode::Chart => {
                "Analyze the chart in the image and describe its content in detail.".to_string()
            }
        }
    }

    fn parse_response(
        &self,
        response: &str,
        image_width: u32,
        image_height: u32,
        page_index: usize,
        image_path: &str,
        mode: OcrMode,
    ) -> Result<OcrPageResult, OcrError> {
        // 通用 VLM 不解析坐标，只返回文本
        Ok(OcrPageResult {
            page_index,
            image_path: image_path.to_string(),
            image_width,
            image_height,
            regions: vec![OcrRegion {
                label: "document".to_string(),
                text: response.trim().to_string(),
                bbox_normalized: None,
                bbox_pixels: None,
                confidence: None,
                raw_output: Some(response.to_string()),
            }],
            markdown_text: Some(response.trim().to_string()),
            engine: OcrEngineType::GenericVlm,
            mode,
            processing_time_ms: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generic_vlm_adapter() {
        let adapter = GenericVlmAdapter::new();
        assert_eq!(adapter.engine_type(), OcrEngineType::GenericVlm);
        assert!(adapter.supports_mode(OcrMode::FreeOcr));
        // L4 fix: 通用 VLM 不支持 Grounding 模式
        assert!(!adapter.supports_mode(OcrMode::Grounding));

        let prompt = adapter.build_prompt(OcrMode::FreeOcr);
        assert!(prompt.contains("markdown"));
    }
}
