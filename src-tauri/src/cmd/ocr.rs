//! OCR 引擎相关命令
//!
//! 提供 OCR 引擎配置和管理的 Tauri 命令。

use crate::commands::AppState;
use crate::llm_manager::OcrModelConfig;
use crate::models::AppError;
use crate::ocr_adapters::{OcrAdapterFactory, OcrEngineType};
use serde::{Deserialize, Serialize};
use tauri::State;

type Result<T> = std::result::Result<T, AppError>;

/// M14 fix: PaddleOCR-VL 自动迁移到 1.5 版本（共享函数）
///
/// 返回 true 表示有变更需要保存
pub fn migrate_paddle_ocr_models(models: &mut [OcrModelConfig]) -> bool {
    let mut changed = false;
    for model in models.iter_mut() {
        if model.model == "PaddlePaddle/PaddleOCR-VL" {
            model.model = "PaddlePaddle/PaddleOCR-VL-1.5".to_string();
            if model.name.contains("PaddleOCR-VL") && !model.name.contains("1.5") {
                model.name = model.name.replace("PaddleOCR-VL", "PaddleOCR-VL-1.5");
            }
            changed = true;
        }
    }
    changed
}

/// OCR 引擎信息（用于前端展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrEngineInfoResponse {
    /// 引擎类型标识
    pub engine_type: String,
    /// 显示名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 推荐的模型名称
    pub recommended_model: String,
    /// 是否支持 grounding
    pub supports_grounding: bool,
    /// 是否免费
    pub is_free: bool,
}

/// 获取所有可用的 OCR 引擎列表
#[tauri::command]
pub async fn get_ocr_engines() -> Result<Vec<OcrEngineInfoResponse>> {
    let engines = OcrAdapterFactory::engine_info_list();

    Ok(engines
        .into_iter()
        .map(|e| OcrEngineInfoResponse {
            engine_type: e.engine_type.as_str().to_string(),
            name: e.name.to_string(),
            description: e.description.to_string(),
            recommended_model: e.recommended_model.to_string(),
            supports_grounding: e.supports_grounding,
            is_free: e.is_free,
        })
        .collect())
}

/// 获取当前配置的 OCR 引擎类型
#[tauri::command]
pub async fn get_ocr_engine_type(state: State<'_, AppState>) -> Result<String> {
    let db = &state.database;

    // 从数据库读取配置，默认使用 DeepSeek-OCR
    let engine_type = db
        .get_setting("ocr.engine_type")
        .map_err(|e| AppError::database(format!("读取 OCR 引擎配置失败: {}", e)))?
        .unwrap_or_else(|| OcrEngineType::DeepSeekOcr.as_str().to_string());

    Ok(engine_type)
}

/// 设置 OCR 引擎类型
#[tauri::command]
pub async fn set_ocr_engine_type(engine_type: String, state: State<'_, AppState>) -> Result<bool> {
    // M5 fix: 严格验证引擎类型，拒绝非法输入
    let parsed = OcrEngineType::try_from_str(&engine_type).ok_or_else(|| {
        AppError::validation(format!(
            "Unknown OCR engine type: '{}'. Valid types: deepseek_ocr, paddle_ocr_vl, generic_vlm",
            engine_type
        ))
    })?;

    let db = &state.database;
    db.save_setting("ocr.engine_type", parsed.as_str())
        .map_err(|e| AppError::database(format!("保存 OCR 引擎配置失败: {}", e)))?;

    Ok(true)
}

/// 根据模型名称推断 OCR 引擎类型
#[tauri::command]
pub async fn infer_ocr_engine_from_model(model: String) -> Result<String> {
    let engine = OcrAdapterFactory::infer_engine_from_model(&model);
    Ok(engine.as_str().to_string())
}

/// 验证模型是否适合指定的 OCR 引擎
#[tauri::command]
pub async fn validate_ocr_model(
    model: String,
    engine_type: String,
) -> Result<ValidateOcrModelResponse> {
    let engine = OcrEngineType::from_str(&engine_type);
    let is_valid = OcrAdapterFactory::validate_model_for_engine(&model, engine);
    let recommended = engine.recommended_model().to_string();

    Ok(ValidateOcrModelResponse {
        is_valid,
        recommended_model: if !is_valid { Some(recommended) } else { None },
    })
}

/// 验证结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateOcrModelResponse {
    pub is_valid: bool,
    pub recommended_model: Option<String>,
}

/// 获取 OCR 引擎的 prompt 模板
#[tauri::command]
pub async fn get_ocr_prompt_template(engine_type: String, mode: String) -> Result<String> {
    use crate::ocr_adapters::OcrMode;

    let engine = OcrEngineType::from_str(&engine_type);
    let mode = OcrMode::from_str(&mode);

    let adapter = OcrAdapterFactory::create(engine);
    let prompt = adapter.build_prompt(mode);

    Ok(prompt)
}

/// 获取已配置的 OCR 模型列表
///
/// 返回通过一键分配或手动配置的所有 OCR 模型
/// 包含自动迁移逻辑：将旧版本 PaddleOCR-VL 模型名称自动更新为 1.5 版本
#[tauri::command]
pub async fn get_available_ocr_models(
    state: State<'_, AppState>,
) -> Result<Vec<AvailableOcrModelResponse>> {
    let db = &state.database;

    // 从数据库读取配置的 OCR 模型列表
    let models_json = db
        .get_setting("ocr.available_models")
        .map_err(|e| AppError::database(format!("读取 OCR 模型配置失败: {}", e)))?;

    if let Some(json) = models_json {
        let mut models: Vec<OcrModelConfig> = serde_json::from_str(&json)
            .map_err(|e| AppError::database(format!("解析 OCR 模型配置失败: {}", e)))?;

        // M14 fix: 使用共享迁移函数
        if migrate_paddle_ocr_models(&mut models) {
            if let Ok(updated_json) = serde_json::to_string(&models) {
                let _ = db.save_setting("ocr.available_models", &updated_json);
                println!("[OCR] 已自动迁移 PaddleOCR-VL 配置到 1.5 版本");
            }
        }

        // 获取内置引擎信息用于合并
        let engine_info_map: std::collections::HashMap<_, _> =
            OcrAdapterFactory::engine_info_list()
                .into_iter()
                .map(|e| (e.engine_type.as_str().to_string(), e))
                .collect();

        let result: Vec<AvailableOcrModelResponse> = models
            .into_iter()
            .map(|m| {
                let engine_info = engine_info_map.get(&m.engine_type);
                AvailableOcrModelResponse {
                    config_id: m.config_id,
                    model: m.model,
                    engine_type: m.engine_type.clone(),
                    name: m.name,
                    is_free: m.is_free,
                    description: engine_info.map(|e| e.description.to_string()),
                    supports_grounding: engine_info.map(|e| e.supports_grounding).unwrap_or(false),
                }
            })
            .collect();

        return Ok(result);
    }

    // 如果没有配置，返回空列表
    Ok(vec![])
}

/// 已配置的 OCR 模型响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableOcrModelResponse {
    /// 模型配置 ID
    pub config_id: String,
    /// 模型名称
    pub model: String,
    /// 引擎类型
    pub engine_type: String,
    /// 显示名称
    pub name: String,
    /// 是否免费
    pub is_free: bool,
    /// 引擎描述
    pub description: Option<String>,
    /// 是否支持坐标定位
    pub supports_grounding: bool,
}

/// 保存 OCR 模型配置列表
#[tauri::command]
pub async fn save_available_ocr_models(
    models: Vec<SaveOcrModelRequest>,
    state: State<'_, AppState>,
) -> Result<bool> {
    let db = &state.database;

    let configs: Vec<OcrModelConfig> = models
        .into_iter()
        .map(|m| OcrModelConfig {
            config_id: m.config_id,
            model: m.model,
            engine_type: m.engine_type,
            name: m.name,
            is_free: m.is_free,
        })
        .collect();

    let json = serde_json::to_string(&configs)
        .map_err(|e| AppError::database(format!("序列化 OCR 模型配置失败: {}", e)))?;

    db.save_setting("ocr.available_models", &json)
        .map_err(|e| AppError::database(format!("保存 OCR 模型配置失败: {}", e)))?;

    Ok(true)
}

/// 保存 OCR 模型请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOcrModelRequest {
    pub config_id: String,
    pub model: String,
    pub engine_type: String,
    pub name: String,
    #[serde(default)]
    pub is_free: bool,
}

// ==================== OCR 引擎测试功能 ====================

/// OCR 测试请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTestRequest {
    /// 图片 base64（支持 data:image/... 格式或纯 base64）
    pub image_base64: String,
    /// 要测试的引擎类型
    pub engine_type: String,
}

/// OCR 测试响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTestResponse {
    /// 引擎类型
    pub engine_type: String,
    /// 引擎名称
    pub engine_name: String,
    /// 识别文本
    pub text: String,
    /// 识别区域（如果支持）
    pub regions: Vec<OcrTestRegion>,
    /// 耗时（毫秒）
    pub elapsed_ms: u64,
    /// 是否成功
    pub success: bool,
    /// 错误信息
    pub error: Option<String>,
}

/// OCR 测试区域
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTestRegion {
    pub text: String,
    pub bbox: Option<[f64; 4]>, // [x, y, width, height] 归一化坐标
    pub label: Option<String>,
}

/// 测试指定引擎的 OCR 能力
///
/// 用于对比不同 OCR 引擎的速度和质量
#[tauri::command]
pub async fn test_ocr_engine(
    request: OcrTestRequest,
    state: State<'_, AppState>,
) -> Result<OcrTestResponse> {
    use crate::ocr_adapters::{OcrAdapterFactory, OcrMode};
    use std::time::Instant;

    let engine_type = OcrEngineType::from_str(&request.engine_type);
    let adapter = OcrAdapterFactory::create(engine_type);
    let engine_info = OcrAdapterFactory::engine_info_list()
        .into_iter()
        .find(|e| e.engine_type == engine_type)
        .map(|e| e.name.to_string())
        .unwrap_or_else(|| engine_type.as_str().to_string());

    let start = Instant::now();

    // 解析 base64 图片
    let image_bytes = parse_base64_image(&request.image_base64)
        .map_err(|e| AppError::validation(format!("图片解析失败: {}", e)))?;

    // 保存到临时文件
    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("ocr_test_temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

    let extension = infer_extension_from_data_url(&request.image_base64);
    let temp_filename = format!("test_{}.{}", uuid::Uuid::new_v4(), extension);
    let temp_path = temp_dir.join(&temp_filename);

    std::fs::write(&temp_path, &image_bytes)
        .map_err(|e| AppError::file_system(format!("写入临时文件失败: {}", e)))?;

    // M10 fix: 确保临时文件在函数退出时被清理
    struct TempFileGuard(std::path::PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup_guard = TempFileGuard(temp_path.clone());

    // 调用 LLM 进行 OCR
    let ocr_result = state
        .llm_manager
        .test_ocr_with_engine(temp_path.to_string_lossy().to_string(), engine_type)
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match ocr_result {
        Ok((text, regions)) => {
            let test_regions: Vec<OcrTestRegion> = regions
                .into_iter()
                .map(|r| OcrTestRegion {
                    text: r.text,
                    bbox: r.bbox_normalized.and_then(|v| {
                        if v.len() == 4 {
                            Some([v[0], v[1], v[2], v[3]])
                        } else {
                            None
                        }
                    }),
                    label: Some(r.label),
                })
                .collect();

            Ok(OcrTestResponse {
                engine_type: engine_type.as_str().to_string(),
                engine_name: engine_info,
                text,
                regions: test_regions,
                elapsed_ms,
                success: true,
                error: None,
            })
        }
        Err(e) => Ok(OcrTestResponse {
            engine_type: engine_type.as_str().to_string(),
            engine_name: engine_info,
            text: String::new(),
            regions: vec![],
            elapsed_ms,
            success: false,
            error: Some(e.to_string()),
        }),
    }
}

/// 解析 base64 图片数据
fn parse_base64_image(data: &str) -> std::result::Result<Vec<u8>, String> {
    use base64::Engine;

    let base64_data = if data.starts_with("data:") {
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

/// 从 data URL 中推断文件扩展名
fn infer_extension_from_data_url(data: &str) -> &'static str {
    if data.starts_with("data:image/png") {
        "png"
    } else if data.starts_with("data:image/gif") {
        "gif"
    } else if data.starts_with("data:image/webp") {
        "webp"
    } else {
        "jpg"
    }
}
