//! 翻译功能命令模块
//! 从 commands.rs 剥离 (原始行号: 13095-13354)

use crate::commands::AppState;
use crate::models::AppError;
use base64::Engine;
use tauri::State;

type Result<T> = std::result::Result<T, AppError>;

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
        let temp_file = temp_dir.join(format!("ocr_temp_{}.png", uuid::Uuid::new_v4()));

        let image_data = base64::engine::general_purpose::STANDARD
            .decode(&base64)
            .map_err(|e| AppError::validation(format!("Base64解码失败: {}", e)))?;
        std::fs::write(&temp_file, image_data)?;

        (temp_file.to_string_lossy().to_string(), true)
    } else if let Some(path) = image_path {
        (path, false)
    } else {
        return Err(AppError::validation("必须提供image_path或image_base64"));
    };

    // ★ 使用 FreeOCR fallback 链路（优先级引擎切换 + 45s 超时）
    let result = state
        .llm_manager
        .call_ocr_free_text_with_fallback(&temp_path.0)
        .await?;

    // 清理临时文件
    if temp_path.1 {
        let _ = std::fs::remove_file(&temp_path.0);
    }

    Ok(result)
}

// 6 个废弃的翻译 CRUD 命令已移除（translate_text, list_translations, update_translation,
// delete_translation, toggle_translation_favorite, rate_translation）。
// 翻译功能已迁移至 DSTU/VFS 路径，流式翻译使用 translate_text_stream。
