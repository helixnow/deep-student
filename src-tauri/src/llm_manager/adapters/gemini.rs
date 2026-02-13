//! Google Gemini 专用适配器
//!
//! Gemini 使用独特的 thinking 配置格式（注意：REST API 使用 camelCase）：
//!
//! ## Gemini 3 (2025-11+)
//! ```json
//! { "thinkingConfig": { "thinkingLevel": "low" | "high" } }
//! ```
//! - **Gemini 3 Pro**: 支持 `"low"`, `"high"`（默认 `"high"`），不能禁用
//! - **Gemini 3 Flash**: 支持 `"minimal"`, `"low"`, `"medium"`, `"high"`
//!
//! ## Gemini 2.5 (退役 2026-06)
//! ```json
//! { "thinkingConfig": { "thinkingBudget": 1024 | -1 | 0 } }
//! ```
//! - **Gemini 2.5 Pro**: 128-32768 tokens，不能禁用
//! - **Gemini 2.5 Flash**: 0-24576 tokens，可设为 0 禁用
//!
//! 参考文档：https://ai.google.dev/gemini-api/docs/thinking

use super::{get_trimmed_effort, resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// Google Gemini 专用适配器
///
/// 处理 Gemini 的 thinking 配置格式（REST API 使用 camelCase）：
/// - Gemini 3: `thinkingLevel: "low" | "high"` (Pro) 或 `"minimal" | "low" | "medium" | "high"` (Flash)
/// - Gemini 2.5: `thinkingBudget: number` (-1 = dynamic, 0 = off for Flash)
pub struct GeminiAdapter;

impl GeminiAdapter {
    /// 检查是否是 Gemini 3 模型
    fn is_gemini_3(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("gemini-3") || model_lower.contains("gemini3")
    }

    /// 检查是否是 Gemini 3 Flash 模型（支持更多 thinkingLevel 值）
    fn is_gemini_3_flash(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        (model_lower.contains("gemini-3") || model_lower.contains("gemini3"))
            && model_lower.contains("flash")
    }

    /// 将 reasoning_effort 映射到 thinkingLevel
    ///
    /// Gemini 3 Pro: 仅支持 "low", "high"
    /// Gemini 3 Flash: 支持 "minimal", "low", "medium", "high"
    fn map_effort_to_level(effort: Option<&str>, is_flash: bool) -> &'static str {
        match effort {
            Some(e) if e.eq_ignore_ascii_case("high") || e.eq_ignore_ascii_case("xhigh") => "high",
            Some(e) if e.eq_ignore_ascii_case("medium") => {
                if is_flash {
                    "medium"
                } else {
                    "high"
                } // Pro 不支持 medium，映射到 high
            }
            Some(e) if e.eq_ignore_ascii_case("minimal") || e.eq_ignore_ascii_case("none") => {
                if is_flash {
                    "minimal"
                } else {
                    "low"
                } // Pro 不支持 minimal，映射到 low
            }
            _ => "low", // 默认使用 low
        }
    }
}

impl RequestAdapter for GeminiAdapter {
    fn id(&self) -> &'static str {
        "google"
    }

    fn label(&self) -> &'static str {
        "Google Gemini"
    }

    fn description(&self) -> &'static str {
        "Gemini 系列，支持 thinkingLevel/thinkingBudget 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // Gemini 不支持 frequency_penalty 和 presence_penalty
        body.remove("frequency_penalty");
        body.remove("presence_penalty");

        let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
        let effort = get_trimmed_effort(config);
        let is_gemini3 = Self::is_gemini_3(&config.model);
        let is_gemini3_flash = Self::is_gemini_3_flash(&config.model);

        // 使用 camelCase 字段名（符合 Gemini REST API 规范）
        let mut thinking_map = Map::new();

        if is_gemini3 {
            // Gemini 3: 使用 thinkingLevel
            // 注意：Gemini 3 Pro 不能完全禁用 thinking，最低是 "low"
            if enable_thinking_value {
                let level = Self::map_effort_to_level(effort, is_gemini3_flash);
                thinking_map.insert("thinkingLevel".to_string(), json!(level));
            } else {
                // 即使用户想禁用，Gemini 3 也要设置最低级别
                let min_level = if is_gemini3_flash { "minimal" } else { "low" };
                thinking_map.insert("thinkingLevel".to_string(), json!(min_level));
            }
        } else {
            // Gemini 2.5: 使用 thinkingBudget
            if enable_thinking_value {
                if let Some(budget) = config.thinking_budget {
                    // Gemini 2.5 Pro: 128-32768, 不能禁用
                    // Gemini 2.5 Flash: 0-24576, 可禁用
                    let clamped = if budget < -1 { -1 } else { budget };
                    thinking_map.insert("thinkingBudget".to_string(), json!(clamped));
                } else {
                    // 默认使用动态思维 (-1)
                    thinking_map.insert("thinkingBudget".to_string(), json!(-1));
                }
            } else {
                // 用户想禁用 thinking（仅 Flash 系列支持）
                let model_lower = config.model.to_lowercase();
                if model_lower.contains("flash") {
                    thinking_map.insert("thinkingBudget".to_string(), json!(0));
                }
                // 2.5 Pro 不能禁用，不添加参数让其使用默认动态模式
            }

            // Gemini 2.5 可能支持 reasoning_effort（兼容 OpenAI 格式）
            if let Some(e) = effort {
                if !e.eq_ignore_ascii_case("none") && !e.eq_ignore_ascii_case("unset") {
                    body.insert("reasoning_effort".to_string(), json!(e));
                }
            }
        }

        // includeThoughts 嵌套在 thinkingConfig 内
        if config.include_thoughts {
            thinking_map.insert("includeThoughts".to_string(), json!(true));
        }

        if !thinking_map.is_empty() {
            body.insert("thinkingConfig".to_string(), Value::Object(thinking_map));
        }

        if !config.gemini_api_version.is_empty() {
            body.insert(
                "gemini_api_version".to_string(),
                json!(config.gemini_api_version.clone()),
            );
        }

        false
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // Gemini 支持采样参数
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gemini_25_thinking_budget() {
        // Gemini 2.5 使用 thinkingBudget（camelCase）
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(4096),
            include_thoughts: true,
            model: "gemini-2.5-pro".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 验证使用 camelCase 字段名
        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingBudget"), Some(&json!(4096)));
        assert_eq!(thinking_config.get("includeThoughts"), Some(&json!(true)));
    }

    #[test]
    fn test_gemini_3_thinking_level() {
        // Gemini 3 Pro 使用 thinkingLevel（camelCase）
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            reasoning_effort: Some("high".to_string()),
            model: "gemini-3-pro-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingLevel"), Some(&json!("high")));
        // Gemini 3 不使用 thinkingBudget
        assert!(!thinking_config
            .as_object()
            .unwrap()
            .contains_key("thinkingBudget"));
    }

    #[test]
    fn test_gemini_3_flash_default_level() {
        // Gemini 3 Flash 默认使用 "low"
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "gemini-3-flash-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingLevel"), Some(&json!("low")));
    }

    #[test]
    fn test_gemini_3_flash_medium_level() {
        // Gemini 3 Flash 支持 "medium"
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            reasoning_effort: Some("medium".to_string()),
            model: "gemini-3-flash-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingLevel"), Some(&json!("medium")));
    }

    #[test]
    fn test_gemini_3_flash_minimal_level() {
        // Gemini 3 Flash 支持 "minimal"（近似禁用）
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: false, // 用户想禁用
            model: "gemini-3-flash-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        // Flash 使用 minimal（最接近禁用）
        assert_eq!(
            thinking_config.get("thinkingLevel"),
            Some(&json!("minimal"))
        );
    }

    #[test]
    fn test_gemini_3_pro_cannot_disable() {
        // Gemini 3 Pro 不能禁用 thinking，最低是 "low"
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: false, // 用户想禁用
            model: "gemini-3-pro-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        // Pro 最低是 "low"
        assert_eq!(thinking_config.get("thinkingLevel"), Some(&json!("low")));
    }

    #[test]
    fn test_reasoning_effort_gemini_25_only() {
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "gemini-2.5-flash".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_gemini_api_version() {
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            gemini_api_version: "v1beta".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("gemini_api_version"), Some(&json!("v1beta")));
    }

    #[test]
    fn test_default_thinking_budget_gemini_25() {
        // Gemini 2.5 默认使用动态 thinkingBudget (-1)
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: None,
            model: "gemini-2.5-pro".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingBudget"), Some(&json!(-1)));
    }

    #[test]
    fn test_gemini_25_flash_disable_thinking() {
        // Gemini 2.5 Flash 可以禁用 thinking
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "gemini-2.5-flash".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking_config = body.get("thinkingConfig").unwrap();
        assert_eq!(thinking_config.get("thinkingBudget"), Some(&json!(0)));
    }

    #[test]
    fn test_removes_penalty_params() {
        let adapter = GeminiAdapter;
        let config = ApiConfig {
            model: "gemini-2.5-pro".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("presence_penalty"));
        assert!(body.contains_key("temperature"));
    }
}
