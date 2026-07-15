//! MiniMax 专用适配器
//!
//! MiniMax API 参数格式按代际区分（2026-07 现状）：
//!
//! ## M3 及之后（MiniMax-M3+，1M 上下文多模态旗舰）
//! - **支持** `thinking: {"type": "adaptive" | "disabled"}`（M3 默认 adaptive 开启）
//! - 用户的关闭意图必须传达（旧实现无条件剥离 thinking，M3 上无法禁用思考）
//!
//! ## M2 及更早（M2 / M2.1 / M2.5 / M2.7）
//! - **不支持** thinking 开关（M2.x 思考无法关闭，传 disabled 被接受但不生效），
//!   保持移除行为避免无效参数
//!
//! ## 通用
//! - **不支持** `enable_thinking` / `thinking_budget` / `include_thoughts`（一律移除）
//! - **支持** `reasoning_split` 控制思维链拆分（不开则 `<think>` 混入 content）
//! - **支持** temperature、top_p 等采样参数（即使是推理模型）
//!
//! 参考文档：https://platform.minimax.io/docs/api-reference/text-openai-api

use super::{PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// MiniMax 专用适配器
///
/// - M3+: thinking:{"type":"adaptive"/"disabled"} 按配置写入
/// - M2 及更早: 移除 thinking（API 不支持关闭）
/// - 保留采样参数（temperature, top_p）
/// - 使用 `reasoning_split` 控制思维链分离
pub struct MiniMaxAdapter;

impl MiniMaxAdapter {
    /// 解析模型名中的 M 系版本号，返回 (major, minor)。
    ///
    /// 示例：
    /// - `MiniMax-M3` → (3, 0)；`MiniMax-M2.7-highspeed` → (2, 7)
    /// - `M2-her` → (2, 0)；`abab6.5s-chat` → None
    fn parse_m_version(model: &str) -> Option<(u32, u32)> {
        let lower = model.to_lowercase();
        let bytes = lower.as_bytes();
        for (i, _) in lower.match_indices('m') {
            // 边界检查：m 前必须是开头或非字母数字字符（如 '-'、'/'）
            if i > 0 && (bytes[i - 1] as char).is_ascii_alphanumeric() {
                continue;
            }
            let rest = &lower[i + 1..];
            let major_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            if major_len == 0 {
                continue;
            }
            let major: u32 = match rest[..major_len].parse() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let after_major = &rest[major_len..];
            let mut minor = 0u32;
            let mut chars = after_major.chars();
            if matches!(chars.next(), Some('.') | Some('-')) {
                let minor_str: String = chars.take_while(|c| c.is_ascii_digit()).collect();
                if (1..=2).contains(&minor_str.len()) {
                    minor = minor_str.parse().unwrap_or(0);
                }
            }
            return Some((major, minor));
        }
        None
    }

    /// M3 及之后支持 `thinking: {"type": "adaptive" | "disabled"}`
    fn supports_thinking_switch(model: &str) -> bool {
        match Self::parse_m_version(model) {
            Some((major, _)) => major >= 3,
            None => false,
        }
    }
}

impl RequestAdapter for MiniMaxAdapter {
    fn id(&self) -> &'static str {
        "minimax"
    }

    fn label(&self) -> &'static str {
        "MiniMax"
    }

    fn description(&self) -> &'static str {
        "MiniMax 系列，M3+ 支持 thinking:{adaptive/disabled}，支持 reasoning_split 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // 这些字段 MiniMax 全系不支持，必须移除
        body.remove("enable_thinking");
        body.remove("thinking_budget");
        body.remove("include_thoughts");

        if Self::supports_thinking_switch(&config.model) {
            // ========== M3 及之后：thinking:{"type":"adaptive"/"disabled"} ==========
            // 保留上游/用户已显式给出的 thinking 对象（归一化 enabled→adaptive）；
            // 否则按配置写入，让"关闭思考"的意图能够传达（M3 默认 adaptive 开启）
            let body_thinking_type = body
                .get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let thinking_on = match body_thinking_type.as_deref() {
                Some("disabled") => false,
                Some("adaptive") | Some("enabled") => true,
                _ => enable_thinking
                    .or(config.enable_thinking)
                    .unwrap_or(config.thinking_enabled || config.is_reasoning),
            };

            body.insert(
                "thinking".to_string(),
                json!({
                    "type": if thinking_on { "adaptive" } else { "disabled" }
                }),
            );
        } else {
            // ========== M2 及更早：思考无法关闭，thinking 参数无效，保持移除 ==========
            body.remove("thinking");
        }

        // This adapter returns early to prevent generic reasoning fields from being
        // reintroduced, so MiniMax-specific fields must be applied before returning.
        if let Some(reasoning_split) = config.reasoning_split {
            body.insert("reasoning_split".to_string(), json!(reasoning_split));
        }

        true // 提前返回，阻止后续代码添加 enable_thinking
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // MiniMax 支持采样参数，不移除
        false
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // MiniMax 特定参数
        if let Some(reasoning_split) = config.reasoning_split {
            body.insert("reasoning_split".to_string(), json!(reasoning_split));
        }

        // 通用参数（MiniMax 也支持部分通用参数）
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("repetition_penalty".to_string(), json!(rep_penalty));
        }
        // MiniMax 不使用 effort/verbosity 参数
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // MiniMax M2/M3 系列使用 reasoning_details 格式
        if config.is_reasoning {
            PassbackPolicy::ReasoningDetails
        } else {
            PassbackPolicy::NoPassback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_config() -> ApiConfig {
        ApiConfig {
            supports_reasoning: true,
            is_reasoning: true,
            thinking_enabled: true,
            reasoning_split: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn test_parse_m_version() {
        assert_eq!(MiniMaxAdapter::parse_m_version("MiniMax-M3"), Some((3, 0)));
        assert_eq!(
            MiniMaxAdapter::parse_m_version("MiniMax-M2.7-highspeed"),
            Some((2, 7))
        );
        assert_eq!(
            MiniMaxAdapter::parse_m_version("MiniMax-M2.5"),
            Some((2, 5))
        );
        assert_eq!(MiniMaxAdapter::parse_m_version("M2-her"), Some((2, 0)));
        assert_eq!(
            MiniMaxAdapter::parse_m_version("MiniMax-M3.5"),
            Some((3, 5))
        );
        assert_eq!(MiniMaxAdapter::parse_m_version("abab6.5s-chat"), None);
    }

    #[test]
    fn test_no_enable_thinking() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M2.5".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // MiniMax 不应该添加 enable_thinking
        assert!(!body.contains_key("enable_thinking"));
    }

    #[test]
    fn test_m2_thinking_removed() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M2.5".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();
        body.insert("thinking".to_string(), json!({"type": "disabled"}));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // M2.x 思考无法关闭，thinking 参数无效，保持移除行为
        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_m3_thinking_adaptive_when_enabled() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // M3 开思考用 adaptive（不是 enabled）
        assert_eq!(body.get("thinking"), Some(&json!({"type": "adaptive"})));
    }

    #[test]
    fn test_m3_thinking_disabled_intent_preserved() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        // 旧实现把 thinking 一律移除，M3 上用户的关闭意图被吞——现在必须传达
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_m3_normalizes_enabled_to_adaptive() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();
        // 上游通用逻辑可能注入 enabled，M3 只接受 adaptive/disabled
        body.insert("thinking".to_string(), json!({"type": "enabled"}));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("thinking"), Some(&json!({"type": "adaptive"})));
    }

    #[test]
    fn test_m3_keeps_explicit_disabled_in_body() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            ..create_test_config() // thinking_enabled: true
        };
        let mut body = Map::new();
        body.insert("thinking".to_string(), json!({"type": "disabled"}));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // body 中已显式给出的 disabled（用户 extra 参数）优先于配置
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_m3_unsupported_fields_removed() {
        let adapter = MiniMaxAdapter;
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            ..create_test_config()
        };
        let mut body = Map::new();
        body.insert("enable_thinking".to_string(), json!(true));
        body.insert("thinking_budget".to_string(), json!(2048));
        body.insert("include_thoughts".to_string(), json!(true));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        assert!(!body.contains_key("enable_thinking"));
        assert!(!body.contains_key("thinking_budget"));
        assert!(!body.contains_key("include_thoughts"));
        assert_eq!(body.get("thinking"), Some(&json!({"type": "adaptive"})));
    }

    #[test]
    fn test_keep_sampling_params() {
        let adapter = MiniMaxAdapter;
        let config = create_test_config();
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(1.0));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // MiniMax 应该保留 temperature 和 top_p
        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
    }

    #[test]
    fn test_reasoning_split() {
        let adapter = MiniMaxAdapter;
        let config = create_test_config();
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        assert_eq!(body.get("reasoning_split"), Some(&json!(true)));
    }

    #[test]
    fn test_reasoning_split_is_applied_through_llm_manager_pipeline() {
        let config = ApiConfig {
            model: "MiniMax-M3".to_string(),
            model_adapter: "minimax".to_string(),
            provider_type: Some("minimax".to_string()),
            reasoning_split: Some(true),
            ..create_test_config()
        };
        let mut body = json!({
            "model": config.model,
            "messages": [],
            "stream": true
        });

        crate::llm_manager::LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

        assert_eq!(body.get("reasoning_split"), Some(&json!(true)));
        assert_eq!(body.get("thinking"), Some(&json!({"type": "adaptive"})));
        assert!(!body.as_object().unwrap().contains_key("enable_thinking"));
    }
}
