//! OCR 适配器公共类型定义
//!
//! 定义所有 OCR 适配器共享的数据结构，确保不同模型输出可以统一处理。

use serde::{Deserialize, Serialize};

/// OCR 引擎类型枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngineType {
    /// DeepSeek-OCR - 支持 grounding 坐标输出
    DeepSeekOcr,
    /// PaddleOCR-VL-1.5（默认）- 百度开源，免费，精度 94.5%
    #[default]
    PaddleOcrVl,
    /// PaddleOCR-VL（旧版备用）- 百度开源，免费
    PaddleOcrVlV1,
    /// GLM-4.6V - 智谱多模态模型，支持 bbox_2d 坐标输出，题目集导入优先引擎
    Glm4vOcr,
    /// 通用多模态模型 - 使用标准 VLM 进行 OCR
    GenericVlm,
    /// 系统 OCR - 调用操作系统内置 OCR 引擎（macOS Vision / Windows.Media.Ocr / iOS Vision）
    SystemOcr,
}

impl OcrEngineType {
    /// 从字符串解析引擎类型（未知类型回退到 PaddleOcrVl）
    pub fn from_str(s: &str) -> Self {
        Self::try_from_str(s).unwrap_or(Self::PaddleOcrVl)
    }

    /// M5 fix: 严格解析，未知类型返回 None
    pub fn try_from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "deepseek_ocr" | "deepseek-ocr" | "deepseek" => Some(Self::DeepSeekOcr),
            "paddle_ocr_vl" | "paddleocr-vl" | "paddleocr_vl" | "paddle" => Some(Self::PaddleOcrVl),
            "paddle_ocr_vl_v1" | "paddleocr-vl-v1" | "paddleocr_vl_v1" => Some(Self::PaddleOcrVlV1),
            "glm4v_ocr" | "glm-4.6v" | "glm4v" | "glm-4v" => Some(Self::Glm4vOcr),
            "generic_vlm" | "generic" | "vlm" => Some(Self::GenericVlm),
            "system_ocr" | "system" | "native" => Some(Self::SystemOcr),
            _ => None,
        }
    }

    /// 转换为字符串标识
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DeepSeekOcr => "deepseek_ocr",
            Self::PaddleOcrVl => "paddle_ocr_vl",
            Self::PaddleOcrVlV1 => "paddle_ocr_vl_v1",
            Self::Glm4vOcr => "glm4v_ocr",
            Self::GenericVlm => "generic_vlm",
            Self::SystemOcr => "system_ocr",
        }
    }

    /// 获取显示名称
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::DeepSeekOcr => "DeepSeek-OCR",
            Self::PaddleOcrVl => "PaddleOCR-VL-1.5",
            Self::PaddleOcrVlV1 => "PaddleOCR-VL",
            Self::Glm4vOcr => "GLM-4.6V",
            Self::GenericVlm => "通用多模态模型",
            Self::SystemOcr => "系统 OCR",
        }
    }

    /// 是否支持 grounding（坐标定位）
    pub fn supports_grounding(&self) -> bool {
        match self {
            Self::DeepSeekOcr => true,
            Self::PaddleOcrVl => true, // PaddleOCR-VL 也支持坐标输出
            Self::PaddleOcrVlV1 => true,
            Self::Glm4vOcr => true,
            Self::GenericVlm => false,
            Self::SystemOcr => false,
        }
    }

    /// 获取推荐的模型名称（硅基流动平台）
    pub fn recommended_model(&self) -> &'static str {
        match self {
            Self::DeepSeekOcr => "deepseek-ai/DeepSeek-OCR",
            Self::PaddleOcrVl => "PaddlePaddle/PaddleOCR-VL-1.5",
            Self::PaddleOcrVlV1 => "PaddlePaddle/PaddleOCR-VL",
            Self::Glm4vOcr => "THUDM/GLM-4.1V-9B-Thinking",
            Self::GenericVlm => "Qwen/Qwen2.5-VL-7B-Instruct",
            Self::SystemOcr => "system",
        }
    }

    /// 是否为系统原生 OCR（不通过 LLM 云端调用）
    pub fn is_native_ocr(&self) -> bool {
        matches!(self, Self::SystemOcr)
    }

    /// 是否为题目集导入优先引擎
    pub fn is_import_preferred(&self) -> bool {
        matches!(self, Self::Glm4vOcr)
    }
}

/// OCR 识别模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OcrMode {
    /// Grounding 模式 - 输出带坐标的结构化结果
    #[default]
    Grounding,
    /// Free OCR 模式 - 仅输出文本（Markdown 格式）
    FreeOcr,
    /// 公式识别模式
    Formula,
    /// 表格识别模式
    Table,
    /// 图表解析模式
    Chart,
}

impl OcrMode {
    /// 从字符串解析模式
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "grounding" => Self::Grounding,
            "free_ocr" | "free" | "markdown" => Self::FreeOcr,
            "formula" => Self::Formula,
            "table" => Self::Table,
            "chart" => Self::Chart,
            _ => Self::Grounding,
        }
    }
}

/// 统一的 OCR 区域结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrRegion {
    /// 区域标签/类型
    pub label: String,
    /// OCR 识别的文本内容
    pub text: String,
    /// 归一化边界框 [x, y, width, height]，范围 0-1
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_normalized: Option<Vec<f64>>,
    /// 像素坐标边界框 [x, y, width, height]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_pixels: Option<Vec<f64>>,
    /// 置信度分数（0-1）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// 原始模型输出（用于调试）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
}

/// 统一的 OCR 页面结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrPageResult {
    /// 页面索引（从 0 开始）
    pub page_index: usize,
    /// 原始图片路径
    pub image_path: String,
    /// 图片宽度（像素）
    pub image_width: u32,
    /// 图片高度（像素）
    pub image_height: u32,
    /// 识别到的区域列表
    pub regions: Vec<OcrRegion>,
    /// 完整的 Markdown 文本输出
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown_text: Option<String>,
    /// 使用的 OCR 引擎
    pub engine: OcrEngineType,
    /// 使用的识别模式
    pub mode: OcrMode,
    /// 处理耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_time_ms: Option<u64>,
}

/// OCR 请求配置（预留，用于未来的统一 OCR 服务）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrRequest {
    /// 图片路径或 Base64 数据
    pub image_source: ImageSource,
    /// OCR 模式
    #[serde(default)]
    pub mode: OcrMode,
    /// 页面索引（用于多页文档）
    #[serde(default)]
    pub page_index: usize,
    /// 自定义 prompt（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
    /// 最大输出 token 数
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// 温度参数
    #[serde(default)]
    pub temperature: f32,
}

fn default_max_tokens() -> u32 {
    4096
}

/// 图片来源（预留，用于未来的统一 OCR 服务）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ImageSource {
    /// 文件路径
    Path(String),
    /// Base64 编码数据（包含 MIME 类型）
    Base64 { mime: String, data: String },
    /// Data URL（data:image/png;base64,...）
    DataUrl(String),
}

impl ImageSource {
    /// 从文件路径创建
    pub fn from_path(path: impl Into<String>) -> Self {
        Self::Path(path.into())
    }

    /// 从 Base64 数据创建
    pub fn from_base64(mime: impl Into<String>, data: impl Into<String>) -> Self {
        Self::Base64 {
            mime: mime.into(),
            data: data.into(),
        }
    }

    /// 从 Data URL 创建
    pub fn from_data_url(url: impl Into<String>) -> Self {
        Self::DataUrl(url.into())
    }

    /// 转换为 Data URL 格式
    pub fn to_data_url(&self) -> Option<String> {
        match self {
            Self::DataUrl(url) => Some(url.clone()),
            Self::Base64 { mime, data } => Some(format!("data:{};base64,{}", mime, data)),
            Self::Path(_) => None, // 需要外部读取文件
        }
    }
}

/// OCR 适配器配置（预留，用于未来的统一 OCR 服务）
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrAdapterConfig {
    /// 引擎类型
    pub engine_type: OcrEngineType,
    /// API 基础 URL
    pub base_url: String,
    /// API 密钥
    pub api_key: String,
    /// 模型名称
    pub model: String,
    /// 模型适配器类型（openai/google/anthropic）
    #[serde(default = "default_adapter")]
    pub model_adapter: String,
    /// 是否启用详细日志
    #[serde(default)]
    pub verbose_logging: bool,
}

fn default_adapter() -> String {
    "openai".to_string()
}

/// OCR 错误类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OcrError {
    /// 配置错误
    Configuration(String),
    /// 网络错误
    Network(String),
    /// API 错误
    Api { status: u16, message: String },
    /// 解析错误
    Parse(String),
    /// 速率限制
    RateLimit { retry_after_ms: Option<u64> },
    /// 图片处理错误
    ImageProcessing(String),
    /// 不支持的功能
    Unsupported(String),
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configuration(msg) => write!(f, "配置错误: {}", msg),
            Self::Network(msg) => write!(f, "网络错误: {}", msg),
            Self::Api { status, message } => write!(f, "API 错误 ({}): {}", status, message),
            Self::Parse(msg) => write!(f, "解析错误: {}", msg),
            Self::RateLimit { retry_after_ms } => {
                if let Some(ms) = retry_after_ms {
                    write!(f, "速率限制，请在 {}ms 后重试", ms)
                } else {
                    write!(f, "速率限制")
                }
            }
            Self::ImageProcessing(msg) => write!(f, "图片处理错误: {}", msg),
            Self::Unsupported(msg) => write!(f, "不支持的功能: {}", msg),
        }
    }
}

impl std::error::Error for OcrError {}

/// 将 OcrError 转换为 AppError
impl From<OcrError> for crate::models::AppError {
    fn from(e: OcrError) -> Self {
        match e {
            OcrError::Configuration(msg) => crate::models::AppError::configuration(msg),
            OcrError::Network(msg) => crate::models::AppError::network(msg),
            OcrError::Api { status, message } => {
                crate::models::AppError::llm(format!("API 错误 ({}): {}", status, message))
            }
            OcrError::Parse(msg) => crate::models::AppError::llm(format!("解析错误: {}", msg)),
            OcrError::RateLimit { retry_after_ms } => {
                let msg = if let Some(ms) = retry_after_ms {
                    format!("速率限制，请在 {}ms 后重试", ms)
                } else {
                    "速率限制".to_string()
                };
                crate::models::AppError::llm(msg)
            }
            OcrError::ImageProcessing(msg) => {
                crate::models::AppError::file_system(format!("图片处理错误: {}", msg))
            }
            OcrError::Unsupported(msg) => {
                crate::models::AppError::configuration(format!("不支持的功能: {}", msg))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_type_parsing() {
        assert_eq!(
            OcrEngineType::from_str("deepseek_ocr"),
            OcrEngineType::DeepSeekOcr
        );
        assert_eq!(
            OcrEngineType::from_str("DeepSeek-OCR"),
            OcrEngineType::DeepSeekOcr
        );
        assert_eq!(
            OcrEngineType::from_str("paddle_ocr_vl"),
            OcrEngineType::PaddleOcrVl
        );
        assert_eq!(
            OcrEngineType::from_str("PaddleOCR-VL"),
            OcrEngineType::PaddleOcrVl
        );
        assert_eq!(
            OcrEngineType::from_str("paddle_ocr_vl_v1"),
            OcrEngineType::PaddleOcrVlV1
        );
        assert_eq!(
            OcrEngineType::from_str("paddleocr-vl-v1"),
            OcrEngineType::PaddleOcrVlV1
        );
        assert_eq!(
            OcrEngineType::from_str("system_ocr"),
            OcrEngineType::SystemOcr
        );
        assert_eq!(
            OcrEngineType::from_str("unknown"),
            OcrEngineType::PaddleOcrVl
        );
    }

    #[test]
    fn test_image_source_to_data_url() {
        let base64 = ImageSource::from_base64("image/png", "abc123");
        assert_eq!(
            base64.to_data_url(),
            Some("data:image/png;base64,abc123".to_string())
        );

        let path = ImageSource::from_path("/path/to/image.png");
        assert_eq!(path.to_data_url(), None);
    }
}
