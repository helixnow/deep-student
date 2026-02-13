//! Anki 制卡命令
//!
//! 从 commands.rs 拆分：流式制卡、AnkiConnect 集成、模型适配器选项
//!
//! ★ 2026-02 清理说明：
//! 以下函数已废弃并删除（错题模块废弃）：
//!   - analyze_step_by_step、start_general_chat_session
//!   - generate_general_chat_metadata、update_chat_metadata_note、update_ocr_note

use crate::commands::{get_default_model_adapter_options, AppState};
use crate::models::AppError;
use tauri::State;

type Result<T> = std::result::Result<T, AppError>;

// ★ 2026-02 清理：analyze_step_by_step 已废弃并删除（错题模块废弃）
// 该函数用于错题分析流程，已不再使用

// ★ 2026-02 清理：以下函数已废弃并删除（错题模块废弃）
// - start_general_chat_session（创建通用聊天会话）
// - generate_general_chat_metadata（生成聊天元数据）
// - build_general_chat_preview（辅助函数）
// - collect_doc_attachment_names（辅助函数）
// - update_chat_metadata_note（更新聊天元数据笔记）
// - update_ocr_note（更新 OCR 笔记）

/// 获取模型适配器选项
///
/// 直接从 ADAPTER_REGISTRY 动态获取，不使用数据库缓存
#[tauri::command]
pub async fn get_model_adapter_options(
    _state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>> {
    // 直接从注册表获取，不再使用数据库缓存
    Ok(get_default_model_adapter_options())
}

/// 保存自定义模型适配器选项
#[tauri::command]
pub async fn save_model_adapter_options(
    state: State<'_, AppState>,
    options: Vec<serde_json::Value>,
) -> Result<()> {
    println!("保存自定义模型适配器选项: {} 个", options.len());

    // 验证选项格式
    for (i, option) in options.iter().enumerate() {
        if !option.is_object() || option.get("value").is_none() || option.get("label").is_none() {
            return Err(AppError::validation(format!(
                "模型适配器选项 {} 格式无效，必须包含 'value' 和 'label' 字段",
                i
            )));
        }
    }

    let options_json = serde_json::to_string(&options)
        .map_err(|e| AppError::validation(format!("序列化模型适配器选项失败: {}", e)))?;

    state
        .database
        .save_setting("model_adapter_options", &options_json)
        .map_err(|e| AppError::database(format!("保存模型适配器选项失败: {}", e)))?;

    println!("模型适配器选项保存成功");
    Ok(())
}
/// 重置模型适配器选项为默认值
#[tauri::command]
pub async fn reset_model_adapter_options(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>> {
    println!("重置模型适配器选项为默认值");

    let default_options = get_default_model_adapter_options();
    let options_json = serde_json::to_string(&default_options)
        .map_err(|e| AppError::validation(format!("序列化默认模型适配器选项失败: {}", e)))?;

    state
        .database
        .save_setting("model_adapter_options", &options_json)
        .map_err(|e| AppError::database(format!("重置模型适配器选项失败: {}", e)))?;

    println!("模型适配器选项重置成功");
    Ok(default_options)
}
