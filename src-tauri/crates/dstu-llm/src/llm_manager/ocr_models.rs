//! OCR 模型配置的系统常量与自动迁移（`cmd::ocr` 按原路径重导出）

use super::OcrModelConfig;

/// 系统 OCR 的合成 config_id（不对应真实 API 配置）
pub const SYSTEM_OCR_CONFIG_ID: &str = "__system_ocr__";

/// M14 fix: PaddleOCR-VL 自动迁移到 1.5 版本（共享函数）
///
/// 返回 true 表示有变更需要保存
pub fn migrate_paddle_ocr_models(models: &mut [OcrModelConfig]) -> bool {
    let mut changed = false;
    for model in models.iter_mut() {
        // 跳过显式配置为旧版的引擎（paddle_ocr_vl_v1 故意使用 PaddleOCR-VL）
        if model.model == "PaddlePaddle/PaddleOCR-VL" && model.engine_type != "paddle_ocr_vl_v1" {
            model.model = "PaddlePaddle/PaddleOCR-VL-1.5".to_string();
            if model.name.contains("PaddleOCR-VL") && !model.name.contains("1.5") {
                model.name = model.name.replace("PaddleOCR-VL", "PaddleOCR-VL-1.5");
            }
            changed = true;
        }
    }
    changed
}

/// 自动迁移：将旧版 GLM-4.1V 替换为可用的视觉模型
///
/// GLM-4.1V-9B-Thinking (9B) 是低质量模型。迁移目标按提供商区分：
/// - 硅基流动（`is_siliconflow=true`）：`zai-org/GLM-4.6V` 已于 2026-08 下架，
///   迁移到仍可用的 Qwen3-VL-8B（engine 改为 generic_vlm）；
/// - 智谱官方（`is_zhipu_official=true`）：官方 API 模型名不带 `zai-org/` 前缀，
///   迁移到 `glm-4.6v`；
/// - 其他提供商：保持原模型不变（避免迁移到目标提供商不存在的模型名）。
/// 返回 true 表示有变更需要保存。
pub fn migrate_glm_ocr_models(
    models: &mut [OcrModelConfig],
    is_siliconflow: impl Fn(&str) -> bool,
    is_zhipu_official: impl Fn(&str) -> bool,
) -> bool {
    let mut changed = false;
    for model in models.iter_mut() {
        if model.engine_type == "glm4v_ocr" && model.model.to_lowercase().contains("glm-4.1v") {
            if is_siliconflow(&model.config_id) {
                model.model = "Qwen/Qwen3-VL-8B-Instruct".to_string();
                model.engine_type = "generic_vlm".to_string();
                if model.name.contains("4.1V") || model.name.contains("4.1v") {
                    model.name = model
                        .name
                        .replace("4.1V", "Qwen3-VL-8B")
                        .replace("4.1v", "Qwen3-VL-8B");
                }
                changed = true;
                println!(
                    "[OCR] 已自动迁移 GLM-4.1V → Qwen/Qwen3-VL-8B-Instruct (硅基流动, engine: generic_vlm)"
                );
            } else if is_zhipu_official(&model.config_id) {
                model.model = "glm-4.6v".to_string();
                model.engine_type = "glm4v_ocr".to_string();
                if model.name.contains("4.1V") || model.name.contains("4.1v") {
                    model.name = model
                        .name
                        .replace("4.1V", "GLM-4.6V")
                        .replace("4.1v", "GLM-4.6V");
                }
                changed = true;
                println!("[OCR] 已自动迁移 GLM-4.1V → glm-4.6v (智谱官方, engine: glm4v_ocr)");
            } else {
                println!("[OCR] 跳过 GLM-4.1V 迁移（无法确定提供商，保持原模型）");
            }
        }
    }
    changed
}
