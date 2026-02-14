//! 系统 OCR 适配器模块
//!
//! 调用操作系统内置的 OCR 引擎，无需网络、无需 API Key、零额外打包。
//!
//! 支持平台：
//! - macOS 10.15+：Apple Vision Framework (VNRecognizeTextRequest)
//! - Windows 10+：Windows.Media.Ocr (OcrEngine)
//! - iOS 13+：Apple Vision Framework（通过 Tauri Swift Plugin，待实现）

#[cfg(target_os = "macos")]
mod macos;

#[cfg(windows)]
mod windows;

use crate::ocr_adapters::{OcrAdapter, OcrEngineType, OcrError, OcrMode, OcrPageResult, OcrRegion};
use async_trait::async_trait;

/// 系统 OCR 适配器
///
/// 调用操作系统原生 OCR API，不通过 LLM 云端。
/// 仅支持 FreeOcr 模式（纯文本输出），不支持 Grounding/公式/表格等高级功能。
pub struct SystemOcrAdapter;

impl SystemOcrAdapter {
    pub fn new() -> Self {
        Self
    }
}

/// 执行系统 OCR（异步包装，内部使用 spawn_blocking 避免阻塞 tokio 运行时）
pub async fn perform_system_ocr(image_data: &[u8]) -> Result<String, OcrError> {
    let data = image_data.to_vec();

    let result = tokio::task::spawn_blocking(move || perform_system_ocr_blocking(&data))
        .await
        .map_err(|e| OcrError::ImageProcessing(format!("OCR task panicked: {}", e)))?;

    result
}

/// 同步执行系统 OCR（平台分发）
fn perform_system_ocr_blocking(image_data: &[u8]) -> Result<String, OcrError> {
    #[cfg(target_os = "macos")]
    {
        return macos::recognize_text_blocking(image_data);
    }

    #[cfg(windows)]
    {
        return windows::recognize_text_blocking(image_data);
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Err(OcrError::Unsupported(
            "System OCR is not available on this platform. \
             Supported: macOS 10.15+, Windows 10+. \
             Please use a VLM-based OCR engine instead."
                .to_string(),
        ))
    }
}

/// 检查当前平台是否支持系统 OCR
pub fn is_platform_supported() -> bool {
    cfg!(target_os = "macos") || cfg!(windows) || cfg!(target_os = "ios")
}

#[async_trait]
impl OcrAdapter for SystemOcrAdapter {
    fn engine_type(&self) -> OcrEngineType {
        OcrEngineType::SystemOcr
    }

    fn supports_mode(&self, mode: OcrMode) -> bool {
        // 系统 OCR 仅支持纯文本识别
        matches!(mode, OcrMode::FreeOcr)
    }

    fn build_prompt(&self, _mode: OcrMode) -> String {
        // 系统 OCR 不使用 prompt，返回空字符串
        String::new()
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
        // 系统 OCR 的结果直接作为文本返回
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
                raw_output: None,
            }],
            markdown_text: Some(response.trim().to_string()),
            engine: OcrEngineType::SystemOcr,
            mode,
            processing_time_ms: None,
        })
    }

    fn recommended_max_tokens(&self, _mode: OcrMode) -> u32 {
        0 // 系统 OCR 不使用 token
    }

    fn requires_high_detail(&self) -> bool {
        false // 系统 OCR 直接处理原始图片
    }
}
