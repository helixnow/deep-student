//! OCR 相关命令处理器
//!
//! 提供纯粹的 OCR 功能，不创建会话或保存图片。
//! 用于 Analysis 模式在 sendMessage 之前预先识别题目内容。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::chat_v2::error::ChatV2Error;
use crate::commands::AppState;

/// OCR 请求
#[derive(Debug, Clone, Deserialize)]
pub struct OcrRequest {
    /// 图片 base64 列表（支持 data:image/... 格式或纯 base64）
    pub images: Vec<String>,
}

/// OCR 响应
#[derive(Debug, Clone, Serialize)]
pub struct OcrResponse {
    /// OCR 识别文本
    pub ocr_text: String,
    /// 识别出的标签
    pub tags: Vec<String>,
    /// 题型
    pub mistake_type: String,
}

/// 执行 OCR 识别
///
/// 该命令只执行 OCR，不创建会话或保存图片到永久存储。
/// 图片会保存到临时文件，OCR 完成后自动清理。
///
/// ## 参数
/// - `request`: OCR 请求，包含图片 base64 列表和学科
/// - `state`: 应用状态
///
/// ## 返回
/// - `Ok(OcrResponse)`: OCR 识别结果
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn chat_v2_perform_ocr(
    request: OcrRequest,
    state: State<'_, AppState>,
) -> Result<OcrResponse, String> {
    log::info!(
        "[ChatV2::OCR] Performing OCR: images_count={}",
        request.images.len()
    );

    // 验证请求
    if request.images.is_empty() {
        return Err(ChatV2Error::Validation("At least one image is required".to_string()).into());
    }

    // 构建 OCR 引擎请求 — 使用适配器官方 prompt
    // DeepSeek-OCR → "Free OCR.", PaddleOCR-VL → "OCR:" 等
    // 不要追加自定义中文指令，专用 OCR 模型只接受其官方 prompt 格式
    let adapter = state.llm_manager.get_ocr_adapter().await;
    let prompt = adapter.build_prompt(crate::ocr_adapters::OcrMode::FreeOcr);

    let mut image_payloads = Vec::new();
    for (index, base64_data) in request.images.iter().enumerate() {
        use base64::Engine;
        let image_bytes = parse_base64_image(base64_data).map_err(|e| {
            ChatV2Error::Validation(format!("Failed to parse image {}: {}", index, e)).to_string()
        })?;
        let mime = infer_mime_from_data_url(base64_data);
        let normalized_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
        image_payloads.push(crate::llm_manager::ImagePayload {
            mime: mime.to_string(),
            base64: normalized_base64,
        });
    }

    // 调用 OCR 引擎（使用当前选择的引擎）
    let ocr_raw = state
        .llm_manager
        .call_ocr_model_raw_prompt(prompt.as_str(), Some(image_payloads))
        .await
        .map_err(|e| {
            log::error!("[ChatV2::OCR] OCR failed: {}", e);
            ChatV2Error::Llm(format!("OCR failed: {}", e)).to_string()
        })?;

    let ocr_text = ocr_raw.assistant_message.trim().to_string();

    // OCR 分类已废弃：仅返回 OCR 结果
    let final_text = ocr_text;

    log::info!(
        "[ChatV2::OCR] OCR completed: text_len={}, tags_count={}, type={}",
        final_text.len(),
        0,
        ""
    );

    Ok(OcrResponse {
        ocr_text: final_text,
        tags: Vec::new(),
        mistake_type: String::new(),
    })
}

/// 解析 base64 图片数据
///
/// 支持两种格式：
/// - data:image/xxx;base64,<data>
/// - 纯 base64 字符串
fn parse_base64_image(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;

    let base64_data = if data.starts_with("data:") {
        // 提取 data URL 中的 base64 部分
        data.split(",")
            .nth(1)
            .ok_or_else(|| "Invalid data URL format".to_string())?
    } else {
        data
    };

    base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

fn infer_mime_from_data_url(data: &str) -> &'static str {
    if data.starts_with("data:image/png") {
        "image/png"
    } else if data.starts_with("data:image/gif") {
        "image/gif"
    } else if data.starts_with("data:image/webp") {
        "image/webp"
    } else if data.starts_with("data:image/bmp") {
        "image/bmp"
    } else if data.starts_with("data:image/heic") {
        "image/heic"
    } else if data.starts_with("data:image/heif") {
        "image/heif"
    } else {
        "image/jpeg"
    }
}
