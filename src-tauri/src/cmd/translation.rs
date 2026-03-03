//! 翻译功能命令模块
//! 从 commands.rs 剥离 (原始行号: 13095-13354)

use crate::commands::AppState;
use crate::models::AppError;
use base64::Engine;
use tauri::State;

type Result<T> = std::result::Result<T, AppError>;

struct TempFileGuard(std::path::PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn infer_extension_from_mime(mime: &str) -> Option<&'static str> {
    let normalized = mime.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

fn infer_extension_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        image::ImageFormat::Png => Some("png"),
        image::ImageFormat::Jpeg => Some("jpg"),
        image::ImageFormat::WebP => Some("webp"),
        image::ImageFormat::Gif => Some("gif"),
        image::ImageFormat::Bmp => Some("bmp"),
        _ => None,
    }
}

fn decode_base64_image_payload(payload: &str) -> Result<(Vec<u8>, &'static str)> {
    let trimmed = payload.trim();
    let (declared_mime, base64_data) = if trimmed.starts_with("data:") {
        let (header, data) = trimmed
            .split_once(',')
            .ok_or_else(|| AppError::validation("Invalid data URL format"))?;
        let mime = header
            .strip_prefix("data:")
            .and_then(|rest| rest.split(';').next())
            .unwrap_or_default();
        (Some(mime), data)
    } else {
        (None, trimmed)
    };

    let image_data = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| AppError::validation(format!("Base64解码失败: {}", e)))?;

    let extension = infer_extension_from_bytes(&image_data)
        .or_else(|| declared_mime.and_then(infer_extension_from_mime))
        .unwrap_or("png");

    Ok((image_data, extension))
}

// ==================== 翻译功能相关命令 ====================

/// OCR提取文本（单页图片识别）
#[tauri::command]
pub async fn ocr_extract_text(
    image_path: Option<String>,
    image_base64: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    if image_path.is_none() && image_base64.is_none() {
        return Err(AppError::validation("必须提供image_path或image_base64"));
    }

    let temp_path = if let Some(base64) = image_base64 {
        let file_manager = &state.file_manager;
        let temp_dir = file_manager.get_writable_app_data_dir().join("temp");
        std::fs::create_dir_all(&temp_dir)?;
        let (image_data, extension) = decode_base64_image_payload(&base64)?;
        let temp_file = temp_dir.join(format!("ocr_temp_{}.{}", uuid::Uuid::new_v4(), extension));
        std::fs::write(&temp_file, image_data)?;

        (temp_file.to_string_lossy().to_string(), true)
    } else if let Some(path) = image_path {
        (path, false)
    } else {
        return Err(AppError::validation("必须提供image_path或image_base64"));
    };

    let _temp_file_guard = if temp_path.1 {
        Some(TempFileGuard(std::path::PathBuf::from(&temp_path.0)))
    } else {
        None
    };

    // ★ 使用 FreeOCR fallback 链路（优先级引擎切换 + 45s 超时）
    let result = state
        .llm_manager
        .call_ocr_free_text_with_fallback(&temp_path.0)
        .await?;

    Ok(result)
}

// 6 个废弃的翻译 CRUD 命令已移除（translate_text, list_translations, update_translation,
// delete_translation, toggle_translation_favorite, rate_translation）。
// 翻译功能已迁移至 DSTU/VFS 路径，流式翻译使用 translate_text_stream。

#[cfg(test)]
mod tests {
    use super::decode_base64_image_payload;

    #[test]
    fn decode_payload_infers_png_from_signature() {
        // PNG 文件签名的 base64（8 字节）
        let (bytes, ext) =
            decode_base64_image_payload("iVBORw0KGgo=").expect("decode should succeed");
        assert_eq!(ext, "png");
        assert_eq!(bytes.len(), 8);
    }

    #[test]
    fn decode_payload_prefers_data_url_mime_when_signature_is_insufficient() {
        // base64 仅包含少量字节，可能无法通过 magic bytes 推断格式；应回退到 data URL 的 mime。
        let data_url = "data:image/webp;base64,AAECAwQF";
        let (_bytes, ext) = decode_base64_image_payload(data_url).expect("decode should succeed");
        assert_eq!(ext, "webp");
    }
}
