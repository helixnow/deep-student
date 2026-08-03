//! 智谱 GLM 专用适配器
//!
//! GLM-4.5+ 系列支持以下推理参数：
//! ```json
//! {
//!   "thinking": {
//!     "type": "enabled" | "disabled",
//!     "clear_thinking": true | false
//!   },
//!   "tool_stream": true
//! }
//! ```
//!
//! ## 版本特性（Z.ai 官方文档确认）
//! - GLM-4.5 / GLM-4.5V: 支持 thinking（Thinking Mode switch）
//! - GLM-4.6 / GLM-4.6V: 支持 thinking + tool_stream + 原生多模态工具调用
//! - GLM-4.7: 支持 thinking（默认启用，**强制思考**）、preserved thinking、interleaved thinking
//! - GLM-5 / GLM-5.1 / GLM-5-Turbo: 继承 GLM-4.7 全部特性（动态思考）
//! - GLM-5.2（现旗舰，1M 上下文）: 额外支持 `reasoning_effort`
//!   （`max` 默认 / `xhigh` / `high` / `medium` / `low` / `minimal` / `none`；
//!   none/minimal 放弃思考，low/medium 服务端映射为 high，xhigh 映射为 max）
//! - GLM-4.1V-9B-Thinking: 内置推理但**不支持** thinking API 参数（返回 20015 错误）
//! - Flash/FlashX 变体: 免费/快速模型，不支持 thinking
//!
//! 参考文档：https://docs.bigmodel.cn/cn/guide/capabilities/thinking 、
//! https://docs.z.ai/guides/vlm/glm-4.6v

use super::{get_trimmed_effort, resolve_enable_thinking, RequestAdapter};
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
    /// GLM-4.5+ 支持 thinking API 参数（排除 flash/flashx 变体和 4.1V）
    pub fn supports_thinking_static(model: &str) -> bool {
        Self::supports_thinking(model)
    }

    fn supports_thinking(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        if model_lower.contains("-flash") || model_lower.contains("4.1v") {
            return false;
        }
        model_lower.contains("glm-4.5")
            || model_lower.contains("glm-4.6")
            || model_lower.contains("glm-4.7")
            || model_lower.contains("glm4.5")
            || model_lower.contains("glm4.6")
            || model_lower.contains("glm4.7")
            || model_lower.contains("glm-5")
            || model_lower.contains("glm5")
    }

    /// GLM-4.6+ 支持 tool_stream
    fn supports_tool_stream(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("glm-4.6")
            || model_lower.contains("glm-4.7")
            || model_lower.contains("glm4.6")
            || model_lower.contains("glm4.7")
            || model_lower.contains("glm-5")
            || model_lower.contains("glm5")
    }

    /// 解析模型名中的 GLM 版本号，返回 (major, minor)。
    ///
    /// 示例：`glm-5.2` → (5, 2)；`glm-5` → (5, 0)；`glm-4.7-flash` → (4, 7)
    fn parse_glm_version(model: &str) -> Option<(u32, u32)> {
        let lower = model.to_lowercase();
        let idx = lower.find("glm")?;
        let mut rest = &lower[idx + "glm".len()..];
        rest = rest.strip_prefix('-').unwrap_or(rest);

        let major_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if major_len == 0 {
            return None;
        }
        let major: u32 = rest[..major_len].parse().ok()?;

        let after_major = &rest[major_len..];
        let mut minor = 0u32;
        let mut chars = after_major.chars();
        if matches!(chars.next(), Some('.') | Some('-')) {
            let minor_str: String = chars.take_while(|c| c.is_ascii_digit()).collect();
            if (1..=2).contains(&minor_str.len()) {
                minor = minor_str.parse().unwrap_or(0);
            }
        }
        Some((major, minor))
    }

    /// GLM-5.2 及以上支持 `reasoning_effort`（07 报告 §3.4）
    fn supports_reasoning_effort(model: &str) -> bool {
        match Self::parse_glm_version(model) {
            Some((major, minor)) => major > 5 || (major == 5 && minor >= 2),
            None => false,
        }
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

        let can_think = Self::supports_thinking(&config.model);

        let mut thinking_map = Map::new();

        if can_think || config.supports_reasoning {
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

        // GLM-5.2+ 支持 reasoning_effort（07 报告 §3.4 全档位）：
        // max（默认）/ xhigh / high / medium / low / minimal / none
        if Self::supports_reasoning_effort(&config.model) {
            if let Some(effort) = get_trimmed_effort(config) {
                let effort_lower = effort.to_lowercase();
                if matches!(
                    effort_lower.as_str(),
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                ) {
                    body.insert("reasoning_effort".to_string(), json!(effort_lower));
                }
            }
        }

        // GLM-4.6+ 支持 tool_stream
        if Self::supports_tool_stream(&config.model) && body.contains_key("tools") {
            body.insert("tool_stream".to_string(), json!(true));
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

        assert!(body.get("thinking").is_none());
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
    fn test_supports_thinking() {
        // GLM-4.5+ 系列（包括视觉模型）
        assert!(ZhipuAdapter::supports_thinking("glm-4.5"));
        assert!(ZhipuAdapter::supports_thinking("zai-org/GLM-4.5V"));
        assert!(ZhipuAdapter::supports_thinking("glm-4.6"));
        assert!(ZhipuAdapter::supports_thinking("zai-org/GLM-4.6V"));
        assert!(ZhipuAdapter::supports_thinking("glm-4.7"));
        assert!(ZhipuAdapter::supports_thinking("glm-5"));
        assert!(ZhipuAdapter::supports_thinking("GLM-5"));
        // GLM-5.x 新版本经 glm-5 前缀命中
        assert!(ZhipuAdapter::supports_thinking("glm-5.1"));
        assert!(ZhipuAdapter::supports_thinking("glm-5.2"));
        assert!(ZhipuAdapter::supports_thinking("glm-5-turbo"));

        // flash 变体不支持 thinking
        assert!(!ZhipuAdapter::supports_thinking("GLM-4.7-Flash"));
        assert!(!ZhipuAdapter::supports_thinking("GLM-4.6V-FlashX"));

        // GLM-4.1V 不支持 thinking 参数
        assert!(!ZhipuAdapter::supports_thinking(
            "THUDM/GLM-4.1V-9B-Thinking"
        ));

        // 旧版本不匹配
        assert!(!ZhipuAdapter::supports_thinking("glm-4"));
        assert!(!ZhipuAdapter::supports_thinking("glm-4.0"));
    }

    // ========== GLM-5.2 reasoning_effort 测试 ==========

    #[test]
    fn test_parse_glm_version() {
        assert_eq!(ZhipuAdapter::parse_glm_version("glm-5.2"), Some((5, 2)));
        assert_eq!(ZhipuAdapter::parse_glm_version("glm-5.1"), Some((5, 1)));
        assert_eq!(ZhipuAdapter::parse_glm_version("glm-5"), Some((5, 0)));
        assert_eq!(ZhipuAdapter::parse_glm_version("glm-5-turbo"), Some((5, 0)));
        assert_eq!(
            ZhipuAdapter::parse_glm_version("glm-4.7-flash"),
            Some((4, 7))
        );
        assert_eq!(
            ZhipuAdapter::parse_glm_version("zai-org/GLM-4.6V"),
            Some((4, 6))
        );
        assert_eq!(ZhipuAdapter::parse_glm_version("glm-5.2[1m]"), Some((5, 2)));
        assert_eq!(ZhipuAdapter::parse_glm_version("qwen3-max"), None);
    }

    #[test]
    fn test_supports_reasoning_effort() {
        assert!(ZhipuAdapter::supports_reasoning_effort("glm-5.2"));
        assert!(ZhipuAdapter::supports_reasoning_effort("GLM-5.2"));
        assert!(ZhipuAdapter::supports_reasoning_effort("glm-5.3")); // 未来版本
        assert!(ZhipuAdapter::supports_reasoning_effort("glm-6")); // 未来版本

        // 5.2 以下不支持
        assert!(!ZhipuAdapter::supports_reasoning_effort("glm-5.1"));
        assert!(!ZhipuAdapter::supports_reasoning_effort("glm-5"));
        assert!(!ZhipuAdapter::supports_reasoning_effort("glm-4.7"));
    }

    #[test]
    fn test_glm52_reasoning_effort_passthrough() {
        let adapter = ZhipuAdapter;
        // 07 报告 §3.4 的档位全集
        for effort in ["none", "minimal", "low", "medium", "high", "xhigh", "max"] {
            let config = ApiConfig {
                model: "glm-5.2".to_string(),
                thinking_enabled: true,
                reasoning_effort: Some(effort.to_string()),
                ..Default::default()
            };
            let mut body = Map::new();

            adapter.apply_reasoning_config(&mut body, &config, None);

            assert_eq!(
                body.get("reasoning_effort"),
                Some(&json!(effort)),
                "effort: {}",
                effort
            );
        }
    }

    #[test]
    fn test_glm51_no_reasoning_effort() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            model: "glm-5.1".to_string(),
            thinking_enabled: true,
            reasoning_effort: Some("max".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 仅 GLM-5.2+ 支持 reasoning_effort
        assert!(!body.contains_key("reasoning_effort"));
        // thinking 开关仍生效
        assert_eq!(
            body.get("thinking").and_then(|v| v.get("type")),
            Some(&json!("enabled"))
        );
    }

    #[test]
    fn test_glm52_invalid_effort_ignored() {
        let adapter = ZhipuAdapter;
        let config = ApiConfig {
            model: "glm-5.2".to_string(),
            thinking_enabled: true,
            reasoning_effort: Some("turbo".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("reasoning_effort"));
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
