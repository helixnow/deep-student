//! xAI Grok 专用适配器
//!
//! 2026-07 现状（Grok 2/3 全系已于 2026-05-15 退役，旧 slug 自动重定向到 grok-4.3）：
//!
//! ## 模型
//! - grok-4.3（别名 grok-4.3-latest / grok-latest）: 当前旗舰，1M 上下文，
//!   支持 `reasoning_effort`（none / low(默认) / medium / high）
//! - grok-4.20-0309-reasoning / -non-reasoning: 上一代旗舰家族
//! - grok-4-1-fast-reasoning / -non-reasoning: 高吞吐低价档（不支持 reasoning_effort）
//! - grok-build-0.1: agentic coding（early access）
//!
//! ## 参数限制
//! - `reasoning_effort` 对 grok-4.3 及之后的推理模型透传（grok-3-mini 时代的限定已过时）
//! - Grok-4 系推理模型 **不支持** presence_penalty / frequency_penalty / stop
//! - xAI 端点无 `min_p` / `top_k` / `repetition_penalty` 参数，不注入
//! - grok-4.20+ 不支持 logprobs/top_logprobs（字段被服务端静默忽略，无需处理）
//!
//! ## 推理参数格式
//! ```json
//! {
//!   "reasoning_effort": "none" | "low" | "medium" | "high"
//! }
//! ```
//!
//! 注：xAI 已把 Chat Completions 标为 legacy、主推 OpenAI Responses 协议；
//! 本适配器服务于 CC 通道（仍可用），Responses 路由由协议层决定。
//!
//! 参考文档：https://docs.x.ai/developers/models 、
//! https://docs.x.ai/developers/model-capabilities/text/reasoning

use super::{get_trimmed_effort, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// xAI Grok 专用适配器
///
/// - reasoning_effort: grok-4.3 及之后的推理模型透传（none/low/medium/high）
/// - Grok-4 系移除 presence/frequency penalty 与 stop
/// - 不注入 xAI 不认识的 min_p/top_k/repetition_penalty
pub struct GrokAdapter;

impl GrokAdapter {
    /// 解析模型名中的 Grok 版本号，返回 (major, minor)。
    ///
    /// 示例：
    /// - `grok-4.3` / `grok-4.3-latest` → (4, 3)
    /// - `grok-4.20-0309-reasoning` → (4, 20)
    /// - `grok-4-1-fast-reasoning` → (4, 1)
    /// - `grok-4` → (4, 0)；`grok-build-0.1` / `grok-latest` → None
    fn parse_grok_version(model: &str) -> Option<(u32, u32)> {
        let lower = model.to_lowercase();
        let idx = lower.find("grok")?;
        let mut rest = &lower[idx + "grok".len()..];
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
            // 1-2 位数字视为小版本号；更长的数字（如 -0309 快照）不算
            if (1..=2).contains(&minor_str.len()) {
                minor = minor_str.parse().unwrap_or(0);
            }
        }
        Some((major, minor))
    }

    /// grok-4.3 及之后的推理模型支持 `reasoning_effort`（none/low/medium/high）。
    /// `-non-reasoning` 变体不发送。
    fn supports_reasoning_effort(model: &str) -> bool {
        if model.to_lowercase().contains("non-reasoning") {
            return false;
        }
        match Self::parse_grok_version(model) {
            Some((major, minor)) => major > 4 || (major == 4 && minor >= 3),
            None => false,
        }
    }

    /// 检查是否是 Grok-4 系列（推理模型，不支持 penalties/stop）
    fn is_grok4(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        model_lower.contains("grok-4") || model_lower.contains("grok4")
    }
}

impl RequestAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn label(&self) -> &'static str {
        "xAI Grok"
    }

    fn description(&self) -> &'static str {
        "Grok 系列，grok-4.3+ 支持 reasoning_effort (none/low/medium/high)"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        _enable_thinking: Option<bool>,
    ) -> bool {
        // reasoning_effort: grok-4.3 及之后的推理模型透传
        // （旧实现只对已退役的 grok-3-mini 发送，grok-4.3 的 effort 被静默丢弃）
        if Self::supports_reasoning_effort(&config.model) {
            if let Some(effort) = get_trimmed_effort(config) {
                // xAI 取值 none / low（默认）/ medium / high；归一化超集取值
                let normalized = match effort.to_lowercase().as_str() {
                    "none" => "none",
                    "minimal" | "low" => "low",
                    "medium" => "medium",
                    "high" | "xhigh" | "max" => "high",
                    _ => "low",
                };
                body.insert("reasoning_effort".to_string(), json!(normalized));
            }
        }

        // Grok-4 系推理模型不支持 presencePenalty, frequencyPenalty, stop
        if Self::is_grok4(&config.model) {
            body.remove("presence_penalty");
            body.remove("frequency_penalty");
            body.remove("presencePenalty");
            body.remove("frequencyPenalty");
            body.remove("stop");
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, _config: &ApiConfig) -> bool {
        // Grok 支持 temperature/top_p
        false
    }

    fn apply_common_params(&self, _body: &mut Map<String, Value>, _config: &ApiConfig) {
        // xAI API 参数表中没有 min_p / top_k / repetition_penalty，
        // 注入会有 400/静默失效风险，一律不发送。
        // Grok 也不使用 reasoning_split, effort, verbosity。
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_grok_version() {
        assert_eq!(GrokAdapter::parse_grok_version("grok-4.3"), Some((4, 3)));
        assert_eq!(
            GrokAdapter::parse_grok_version("grok-4.3-latest"),
            Some((4, 3))
        );
        assert_eq!(
            GrokAdapter::parse_grok_version("grok-4.20-0309-reasoning"),
            Some((4, 20))
        );
        assert_eq!(
            GrokAdapter::parse_grok_version("grok-4-1-fast-reasoning"),
            Some((4, 1))
        );
        assert_eq!(GrokAdapter::parse_grok_version("grok-4"), Some((4, 0)));
        assert_eq!(GrokAdapter::parse_grok_version("grok-3-mini"), Some((3, 0)));
        assert_eq!(GrokAdapter::parse_grok_version("grok-build-0.1"), None);
        assert_eq!(GrokAdapter::parse_grok_version("grok-latest"), None);
    }

    #[test]
    fn test_grok43_reasoning_effort_passthrough() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("medium".to_string()),
            model: "grok-4.3".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // grok-4.3 支持四档，medium 不能再被归一化到 low/high
        assert_eq!(body.get("reasoning_effort"), Some(&json!("medium")));
    }

    #[test]
    fn test_grok43_reasoning_effort_none() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("none".to_string()),
            model: "grok-4.3-latest".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // none（关闭推理）应可透传
        assert_eq!(body.get("reasoning_effort"), Some(&json!("none")));
    }

    #[test]
    fn test_grok420_reasoning_effort_passthrough() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "grok-4.20-0309-reasoning".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 4.20 > 4.3，推理变体透传
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_non_reasoning_variant_no_effort() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "grok-4.20-0309-non-reasoning".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非推理变体不发送 reasoning_effort
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_grok41_fast_no_effort() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            model: "grok-4-1-fast-reasoning".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 4.1 < 4.3：不支持 reasoning_effort
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_effort_normalization_superset_values() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("xhigh".to_string()),
            model: "grok-4.3".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // xAI 无 xhigh 档，归一化为 high
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_grok4_removes_unsupported_params() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            model: "grok-4.3".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("stop".to_string(), json!(["END"]));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // Grok-4 系不支持这些参数
        assert!(!body.contains_key("presence_penalty"));
        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("stop"));
    }

    #[test]
    fn test_no_nonstandard_param_injection() {
        let adapter = GrokAdapter;
        let config = ApiConfig {
            model: "grok-4.3".to_string(),
            min_p: Some(0.1),
            top_k: Some(50),
            repetition_penalty: Some(1.1),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        // xAI 端点没有这些参数，不能注入
        assert!(!body.contains_key("min_p"));
        assert!(!body.contains_key("top_k"));
        assert!(!body.contains_key("repetition_penalty"));
    }
}
