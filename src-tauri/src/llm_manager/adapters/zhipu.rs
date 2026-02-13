//! 智谱 GLM 专用适配器
//!
//! GLM-4.7/GLM-5 系列支持以下推理参数：
//! ```json
//! {
//!   "thinking": {
//!     "type": "enabled" | "disabled",
//!     "clear_thinking": true | false  // 是否保留历史思维链
//!   },
//!   "tool_stream": true  // GLM-4.6+ 支持工具流式
//! }
//! ```
//!
//! ## 特殊行为
//! - GLM-4.7/GLM-5 **默认启用 thinking**（需显式禁用）
//! - 支持 turn-level thinking（每轮独立控制）
//! - 支持 preserved thinking（保留历史思维链，通过 clear_thinking: false）
//!
//! ## 版本特性
//! - GLM-4.6: 支持 tool_stream
//! - GLM-4.7: 支持 thinking（默认启用）、preserved thinking
//! - GLM-5: 继承 GLM-4.7 全部特性，745B MoE 架构，200K 上下文
//!
//! 参考文档：https://open.bigmodel.cn/dev/api

use super::{resolve_enable_thinking, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 智谱 GLM 专用适配器
///
/// GLM-4.7 模型的参数处理：
/// - thinking.type: enabled | disabled
/// - thinking.clear_thinking: 是否清除历史思维链（false = 保留思维链）
/// - tool_stream: 工具流式输出
pub struct ZhipuAdapter;

impl ZhipuAdapter {
    /// 检查是否是 GLM-4.7+ 模型（默认启用 thinking）
    /// GLM-5 继承 GLM-4.7 的 thinking 能力，默认启用
    fn is_glm47_or_later(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("glm-4.7")
            || model_lower.contains("glm4.7")
            || model_lower.contains("glm-5")
            || model_lower.contains("glm5")
    }

    /// 检查是否是 GLM-4.6+ 模型（支持 tool_stream）
    /// GLM-5 继承 GLM-4.6+ 的 tool_stream 能力
    fn supports_tool_stream(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("glm-4.6")
            || model_lower.contains("glm-4.7")
            || model_lower.contains("glm4.6")
            || model_lower.contains("glm4.7")
            || model_lower.contains("glm-5")
            || model_lower.contains("glm5")
    }
}

impl RequestAdapter for ZhipuAdapter {
    fn id(&self) -> &'static str {
        "zhipu"
    }

    fn label(&self) -> &'static str {
        "智谱 GLM"
    }

    fn description(&self) -> &'static str {
        "GLM 系列，支持 thinking.type/clear_thinking 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // 智谱 GLM 不支持 frequency_penalty 和 presence_penalty
        body.remove("frequency_penalty");
        body.remove("presence_penalty");

        let is_glm47 = Self::is_glm47_or_later(&config.model);

        let mut thinking_map = Map::new();

        // GLM-4.7 默认启用 thinking，除非显式禁用
        if is_glm47 || config.supports_reasoning {
            let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
            let thinking_type = if enable_thinking_value {
                "enabled"
            } else {
                "disabled"
            };
            thinking_map.insert("type".to_string(), json!(thinking_type));

            // Preserved Thinking: 当 include_thoughts=true 时保留历史思维链
            // clear_thinking: false 表示不清除历史思维链内容
            if config.include_thoughts {
                thinking_map.insert("clear_thinking".to_string(), json!(false));
            }
        }

        if !thinking_map.is_empty() {
            body.insert("thinking".to_string(), Value::Object(thinking_map));
        }

        // GLM-4.6+ 支持 tool_stream
        if Self::supports_tool_stream(&config.model) {
            if body.contains_key("tools") {
                body.insert("tool_stream".to_string(), json!(true));
            }
        }

        false
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // 智谱支持采样参数
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glm47_thinking_enabled() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "glm-4.7".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
    }

    #[test]
    fn test_glm47_thinking_disabled() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "glm-4.7-flash".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("disabled")));
    }

    #[test]
    fn test_tool_stream() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            model: "glm-4.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("tools".to_string(), json!([]));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("tool_stream"), Some(&json!(true)));
    }

    #[test]
    fn test_clear_thinking() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            include_thoughts: true,
            model: "glm-4.7".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("clear_thinking"), Some(&json!(false)));
    }

    #[test]
    fn test_removes_penalty_params() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            model: "glm-4.6".to_string(),
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

    // ========== GLM-4.7 Preserved Thinking 测试 ==========

    #[test]
    fn test_glm47_preserved_thinking() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            include_thoughts: true,
            model: "glm-4.7".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(thinking.get("clear_thinking"), Some(&json!(false)));
    }

    #[test]
    fn test_is_glm47_or_later() {
        // GLM-4.7 系列
        assert!(ZhipuAdapter::is_glm47_or_later("glm-4.7"));
        assert!(ZhipuAdapter::is_glm47_or_later("GLM-4.7-Flash"));
        assert!(ZhipuAdapter::is_glm47_or_later("glm4.7"));

        // GLM-5 系列
        assert!(ZhipuAdapter::is_glm47_or_later("glm-5"));
        assert!(ZhipuAdapter::is_glm47_or_later("GLM-5"));
        assert!(ZhipuAdapter::is_glm47_or_later("glm5"));

        // 旧版本不应匹配
        assert!(!ZhipuAdapter::is_glm47_or_later("glm-4.6"));
        assert!(!ZhipuAdapter::is_glm47_or_later("glm-4"));
    }

    #[test]
    fn test_turn_level_thinking_override() {
        let adapter = ZhipuAdapter;
        // 配置默认启用 thinking
        let config = ApiConfig {
            thinking_enabled: true,
            model: "glm-4.7".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        // 但本轮显式禁用
        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("disabled")));
    }

    #[test]
    fn test_turn_level_thinking_enable() {
        let adapter = ZhipuAdapter;
        // 配置默认禁用 thinking
        let config = ApiConfig {
            thinking_enabled: false,
            model: "glm-4.7".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        // 但本轮显式启用
        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
    }
}
