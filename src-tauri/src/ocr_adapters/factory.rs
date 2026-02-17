//! OCR 适配器工厂
//!
//! 提供统一的适配器创建和管理功能。

use super::{
    DeepSeekOcrAdapter, GenericVlmAdapter, OcrAdapter, OcrEngineType, PaddleOcrVlAdapter,
    SystemOcrAdapter,
};
use std::sync::Arc;

/// OCR 适配器工厂
///
/// 根据引擎类型创建对应的适配器实例。
pub struct OcrAdapterFactory;

impl OcrAdapterFactory {
    /// 根据引擎类型创建适配器
    pub fn create(engine_type: OcrEngineType) -> Arc<dyn OcrAdapter> {
        match engine_type {
            OcrEngineType::DeepSeekOcr => Arc::new(DeepSeekOcrAdapter::new()),
            OcrEngineType::PaddleOcrVl => Arc::new(PaddleOcrVlAdapter::new()),
            OcrEngineType::PaddleOcrVlV1 => Arc::new(PaddleOcrVlAdapter::with_engine(OcrEngineType::PaddleOcrVlV1)),
            OcrEngineType::GenericVlm => Arc::new(GenericVlmAdapter::new()),
            OcrEngineType::SystemOcr => Arc::new(SystemOcrAdapter::new()),
        }
    }

    /// 根据引擎类型字符串创建适配器
    pub fn create_from_str(engine_type: &str) -> Arc<dyn OcrAdapter> {
        Self::create(OcrEngineType::from_str(engine_type))
    }

    /// 获取所有可用的引擎类型
    pub fn available_engines() -> Vec<OcrEngineType> {
        let mut engines = vec![
            OcrEngineType::DeepSeekOcr,
            OcrEngineType::PaddleOcrVl,
            OcrEngineType::PaddleOcrVlV1,
            OcrEngineType::GenericVlm,
        ];
        // 仅在支持的平台上展示系统 OCR 选项
        if super::system_ocr::is_platform_supported() {
            engines.push(OcrEngineType::SystemOcr);
        }
        engines
    }

    /// 获取引擎信息列表（用于 UI 展示）
    pub fn engine_info_list() -> Vec<OcrEngineInfo> {
        let mut list = vec![
            OcrEngineInfo {
                engine_type: OcrEngineType::DeepSeekOcr,
                name: "DeepSeek-OCR",
                description: "专业 OCR 模型，支持 Grounding 坐标输出，适合题目集识别",
                recommended_model: "deepseek-ai/DeepSeek-OCR",
                supports_grounding: true,
                is_free: false,
            },
            OcrEngineInfo {
                engine_type: OcrEngineType::PaddleOcrVl,
                name: "PaddleOCR-VL-1.5",
                description:
                    "百度开源 OCR 视觉语言模型 1.5 版，支持 109 种语言，精度 94.5%，完全免费",
                recommended_model: "PaddlePaddle/PaddleOCR-VL-1.5",
                supports_grounding: true,
                is_free: true,
            },
            OcrEngineInfo {
                engine_type: OcrEngineType::PaddleOcrVlV1,
                name: "PaddleOCR-VL",
                description:
                    "百度开源 OCR 视觉语言模型旧版，支持坐标输出，完全免费，作为 1.5 版的备用",
                recommended_model: "PaddlePaddle/PaddleOCR-VL",
                supports_grounding: true,
                is_free: true,
            },
            OcrEngineInfo {
                engine_type: OcrEngineType::GenericVlm,
                name: "通用多模态模型",
                description: "使用通用 VLM 进行 OCR，适合简单文档识别",
                recommended_model: "Qwen/Qwen2.5-VL-7B-Instruct",
                supports_grounding: false,
                is_free: false,
            },
        ];
        // 仅在支持的平台上展示系统 OCR
        if super::system_ocr::is_platform_supported() {
            list.push(OcrEngineInfo {
                engine_type: OcrEngineType::SystemOcr,
                name: "系统 OCR",
                description: "调用操作系统内置 OCR 引擎，免费离线，无需 API Key",
                recommended_model: "system",
                supports_grounding: false,
                is_free: true,
            });
        }
        list
    }

    /// L5 fix: 验证模型是否适合指定的引擎类型（收紧匹配规则）
    pub fn validate_model_for_engine(model: &str, engine_type: OcrEngineType) -> bool {
        let model_lower = model.to_lowercase();

        match engine_type {
            OcrEngineType::DeepSeekOcr => {
                model_lower.contains("deepseek") && model_lower.contains("ocr")
            }
            OcrEngineType::PaddleOcrVl | OcrEngineType::PaddleOcrVlV1 => {
                // 收紧匹配：要求包含 "paddleocr" 或 "paddlepaddle" 而非单独的 "paddle"
                model_lower.contains("paddleocr") || model_lower.contains("paddlepaddle")
            }
            OcrEngineType::GenericVlm => {
                // 通用 VLM 接受任何多模态模型
                true
            }
            OcrEngineType::SystemOcr => {
                // 系统 OCR 不使用模型名称
                model_lower == "system" || model_lower.is_empty()
            }
        }
    }

    /// 根据模型名称推断引擎类型
    pub fn infer_engine_from_model(model: &str) -> OcrEngineType {
        let model_lower = model.to_lowercase();

        if model_lower == "system" {
            OcrEngineType::SystemOcr
        } else if model_lower.contains("deepseek") && model_lower.contains("ocr") {
            OcrEngineType::DeepSeekOcr
        } else if model_lower.contains("paddleocr-vl-1") || model_lower.contains("paddleocr_vl_1") {
            OcrEngineType::PaddleOcrVl
        } else if model_lower.contains("paddle") || model_lower.contains("paddleocr") {
            // 无版本后缀的 PaddleOCR 默认推断为旧版
            OcrEngineType::PaddleOcrVlV1
        } else {
            OcrEngineType::GenericVlm
        }
    }
}

/// OCR 引擎信息
#[derive(Debug, Clone)]
pub struct OcrEngineInfo {
    /// 引擎类型
    pub engine_type: OcrEngineType,
    /// 显示名称
    pub name: &'static str,
    /// 描述
    pub description: &'static str,
    /// 推荐的模型名称
    pub recommended_model: &'static str,
    /// 是否支持 grounding
    pub supports_grounding: bool,
    /// 是否免费
    pub is_free: bool,
}

impl serde::Serialize for OcrEngineInfo {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("OcrEngineInfo", 6)?;
        state.serialize_field("engineType", &self.engine_type.as_str())?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("recommendedModel", &self.recommended_model)?;
        state.serialize_field("supportsGrounding", &self.supports_grounding)?;
        state.serialize_field("isFree", &self.is_free)?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_adapters() {
        let deepseek = OcrAdapterFactory::create(OcrEngineType::DeepSeekOcr);
        assert_eq!(deepseek.engine_type(), OcrEngineType::DeepSeekOcr);

        let paddle = OcrAdapterFactory::create(OcrEngineType::PaddleOcrVl);
        assert_eq!(paddle.engine_type(), OcrEngineType::PaddleOcrVl);

        let paddle_v1 = OcrAdapterFactory::create(OcrEngineType::PaddleOcrVlV1);
        assert_eq!(paddle_v1.engine_type(), OcrEngineType::PaddleOcrVlV1);

        let generic = OcrAdapterFactory::create(OcrEngineType::GenericVlm);
        assert_eq!(generic.engine_type(), OcrEngineType::GenericVlm);
    }

    #[test]
    fn test_create_from_str() {
        let adapter = OcrAdapterFactory::create_from_str("deepseek_ocr");
        assert_eq!(adapter.engine_type(), OcrEngineType::DeepSeekOcr);

        let adapter = OcrAdapterFactory::create_from_str("paddle_ocr_vl");
        assert_eq!(adapter.engine_type(), OcrEngineType::PaddleOcrVl);
    }

    #[test]
    fn test_validate_model() {
        assert!(OcrAdapterFactory::validate_model_for_engine(
            "deepseek-ai/DeepSeek-OCR",
            OcrEngineType::DeepSeekOcr
        ));

        assert!(OcrAdapterFactory::validate_model_for_engine(
            "PaddlePaddle/PaddleOCR-VL-1.5",
            OcrEngineType::PaddleOcrVl
        ));

        assert!(OcrAdapterFactory::validate_model_for_engine(
            "PaddlePaddle/PaddleOCR-VL",
            OcrEngineType::PaddleOcrVlV1
        ));

        assert!(!OcrAdapterFactory::validate_model_for_engine(
            "Qwen/Qwen2.5-VL",
            OcrEngineType::DeepSeekOcr
        ));
    }

    #[test]
    fn test_infer_engine() {
        assert_eq!(
            OcrAdapterFactory::infer_engine_from_model("deepseek-ai/DeepSeek-OCR"),
            OcrEngineType::DeepSeekOcr
        );

        assert_eq!(
            OcrAdapterFactory::infer_engine_from_model("PaddlePaddle/PaddleOCR-VL-1.5"),
            OcrEngineType::PaddleOcrVl
        );

        assert_eq!(
            OcrAdapterFactory::infer_engine_from_model("PaddlePaddle/PaddleOCR-VL"),
            OcrEngineType::PaddleOcrVlV1
        );

        assert_eq!(
            OcrAdapterFactory::infer_engine_from_model("Qwen/Qwen2.5-VL-7B"),
            OcrEngineType::GenericVlm
        );
    }
}
