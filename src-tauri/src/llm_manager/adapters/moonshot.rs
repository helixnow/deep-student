//! 月之暗面 Kimi 专用适配器
//!
//! Kimi K2.5–K2.7 与 K3 使用不同的推理参数契约：
//!
//! ## K2.5+ 新代际模型（含 K2.6 旗舰、K2.7-code）
//! - **thinking 参数**：`{"type": "enabled" | "disabled"}`；K2.6 默认开启思考，
//!   K2.7-code 强制思考（`type` 只接受 `enabled`）
//! - **Preserved Thinking**：`thinking.keep: "all"`（K2.6 可选、K2.7-code 强制）
//! - **锁死采样参数**：temperature=1.0（非思考 0.6）、top_p=0.95、n=1、penalties=0.0，
//!   传入非固定值会**直接报错**（不是静默忽略），必须整体移除
//! - **max_tokens 已废弃**：改用 `max_completion_tokens`；不传时默认值很小，需显式设置（默认 32768）
//! - **tool_choice 限制**：thinking 模式下只能是 "auto" 或 "none"
//! - 思维链经 `reasoning_content` 返回，工具调用链内必须回传（DeepSeekStyle）
//!
//! ## K3+
//! - 不接受 K2.x 的 `thinking` 对象
//! - 推理固定为 `reasoning_effort: "max"`，不可关闭
//!
//! ## 版本识别
//! 不再枚举子串，而是解析模型名中的 `k<major>[./-]<minor>` 版本号：
//! K2.5–K2.7 走 K2 新代际路径；K3+ 必须先进入独立路径；
//! 快照日期后缀（如 kimi-k2-0905-preview）不会被误判为小版本号。
//!
//! ## 已停服模型（2026-07 现状）
//! - kimi-k2 全系（k2-0711/0905-preview、k2-turbo-preview、k2-thinking*，2026-05-25 停）
//! - kimi-latest（2026-01-28 停）、kimi-thinking-preview（2025-11-11 停）
//! - 旧路径仅为向后兼容保留（用户自定义端点可能仍托管同名模型）
//!
//! ## 输出格式
//! ```json
//! {
//!   "reasoning_content": "思考过程...",
//!   "content": "最终答案..."
//! }
//! ```
//!
//! 参考文档：https://platform.kimi.ai/docs/api/chat 、
//! https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart

use super::{PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 月之暗面 Kimi 专用适配器
///
/// - K2.5+（含 K2.6/K2.7-code 及未来版本）: thinking 参数、锁死采样参数、
///   max_completion_tokens 迁移、Preserved Thinking
/// - 遗留 K2 Thinking: 强制 temperature = 1.0, max_tokens >= 16000
pub struct MoonshotAdapter;

impl MoonshotAdapter {
    /// 解析模型名中的 Kimi K 系版本号，返回 (major, minor)。
    ///
    /// 示例：
    /// - `kimi-k2.6` → (2, 6)；`kimi-k2-5` → (2, 5)；`kimi-k2.7-code` → (2, 7)
    /// - `kimi-k2` / `kimi-k2-thinking` → (2, 0)
    /// - `kimi-k2-0905-preview` → (2, 0)（3 位以上数字视为快照日期而非小版本号）
    /// - `moonshot-v1-128k` → None（`k` 前是字母数字，不是版本边界）
    fn parse_k_version(model: &str) -> Option<(u32, u32)> {
        let lower = model.to_lowercase();
        let bytes = lower.as_bytes();
        for (i, _) in lower.match_indices('k') {
            // 边界检查：k 前必须是开头或非字母数字字符（如 '-'、'/'）
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
                // 1-2 位数字视为小版本号；3 位以上（如 -0905）视为快照日期
                if (1..=2).contains(&minor_str.len()) {
                    minor = minor_str.parse().unwrap_or(0);
                }
            }
            return Some((major, minor));
        }
        None
    }

    /// K2.5 及以上的 K2.x 代际：
    /// 锁死采样参数、thinking 参数、max_completion_tokens
    fn is_k25_or_later(model: &str) -> bool {
        match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 5,
            None => false,
            _ => false,
        }
    }

    fn is_k3_or_later(model: &str) -> bool {
        matches!(Self::parse_k_version(model), Some((major, _)) if major >= 3)
    }

    /// K2.6 及以上支持 `thinking.keep: "all"`（Preserved Thinking）
    fn supports_thinking_keep(model: &str) -> bool {
        match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 6,
            None => false,
            _ => false,
        }
    }

    /// K2.7-code 系：强制思考（thinking.type 只接受 enabled）+ 强制 keep: "all"
    fn is_forced_thinking_code_model(model: &str) -> bool {
        let is_k27_or_later = match Self::parse_k_version(model) {
            Some((2, minor)) => minor >= 7,
            None => false,
            _ => false,
        };
        is_k27_or_later && model.to_lowercase().contains("code")
    }

    /// 检查是否是 Thinking 模型（遗留 K2 Thinking 或 K2.5+ 新代际）
    fn is_thinking_model(model: &str) -> bool {
        model.to_lowercase().contains("thinking")
            || Self::is_k25_or_later(model)
            || Self::is_k3_or_later(model)
    }

    /// 遗留 Thinking 模型的最小 max_tokens
    const MIN_MAX_TOKENS_FOR_THINKING: u32 = 16000;

    /// 遗留 Thinking 模型的推荐 max_tokens
    const RECOMMENDED_MAX_TOKENS: u32 = 32000;

    /// K2.5+ 的默认 max_completion_tokens（官方默认值很小，必须显式设置）
    const K25_DEFAULT_MAX_TOKENS: u32 = 32768;
}

impl RequestAdapter for MoonshotAdapter {
    fn id(&self) -> &'static str {
        "moonshot"
    }

    fn label(&self) -> &'static str {
        "Kimi/Moonshot"
    }

    fn description(&self) -> &'static str {
        "Kimi K2.5–K2.7 thinking 与 K3 reasoning_effort 参数适配"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        if Self::is_k3_or_later(&config.model) {
            // K3 的推理不可关闭，且服务端拒绝 K2.x `thinking` 对象。
            body.remove("thinking");
            body.remove("enable_thinking");
            body.remove("thinking_budget");
            body.remove("include_thoughts");
            body.insert("reasoning_effort".to_string(), json!("max"));
            return true;
        }

        let is_new_gen = Self::is_k25_or_later(&config.model);
        let is_thinking = Self::is_thinking_model(&config.model);

        if is_new_gen {
            // ========== K2.5+ 新代际处理（K2.5 / K2.6 / K2.7-code / 未来 k2.x）==========
            let forced_thinking = Self::is_forced_thinking_code_model(&config.model);

            // K2.7-code 强制思考（thinking.type 只接受 enabled）；
            // 其余模型：外部覆盖 > 配置 enable_thinking > 默认启用（K2.5/K2.6 默认思考）
            let thinking_enabled = if forced_thinking {
                true
            } else {
                enable_thinking.or(config.enable_thinking).unwrap_or(true)
            };

            let mut thinking_map = Map::new();
            thinking_map.insert(
                "type".to_string(),
                json!(if thinking_enabled {
                    "enabled"
                } else {
                    "disabled"
                }),
            );
            // Preserved Thinking（跨轮保留历史 reasoning_content）：
            // K2.7-code 强制 keep:"all"；K2.6+ 在 include_thoughts 开启时携带
            if Self::supports_thinking_keep(&config.model)
                && thinking_enabled
                && (forced_thinking || config.include_thoughts)
            {
                thinking_map.insert("keep".to_string(), json!("all"));
            }
            body.insert("thinking".to_string(), Value::Object(thinking_map));

            // K2.5+ 锁死采样参数（temperature=1.0/0.6, top_p=0.95, n=1, penalties=0.0），
            // 传非固定值直接报错——移除让 API 使用内部默认值
            body.remove("temperature");
            body.remove("top_p");
            body.remove("n");
            body.remove("presence_penalty");
            body.remove("frequency_penalty");

            // max_tokens 已废弃 → max_completion_tokens；
            // 不传时官方默认值很小，必须显式设置（默认 32768）
            let legacy_max_tokens = body
                .remove("max_tokens")
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0);
            let existing_completion = body
                .get("max_completion_tokens")
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0);
            let resolved_max = existing_completion
                .or(legacy_max_tokens)
                .unwrap_or(Self::K25_DEFAULT_MAX_TOKENS as u64);
            body.insert("max_completion_tokens".to_string(), json!(resolved_max));

            // thinking 模式下 tool_choice 只能是 "auto" 或 "none"，其他值直接报错
            if thinking_enabled {
                if let Some(tool_choice) = body.get("tool_choice") {
                    let choice_str = tool_choice.as_str().unwrap_or("");
                    if choice_str != "auto" && choice_str != "none" {
                        body.insert("tool_choice".to_string(), json!("auto"));
                    }
                }
            }

            return true; // 新代际已完成所有处理，跳过通用逻辑
        }

        if is_thinking {
            // ========== 遗留 K2 Thinking 处理（向后兼容，官方已停服）==========
            // Thinking 模型强制 temperature = 1.0
            body.insert("temperature".to_string(), json!(1.0));

            // 确保 max_tokens 足够大
            let current_max_tokens =
                body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            if current_max_tokens < Self::MIN_MAX_TOKENS_FOR_THINKING {
                body.insert(
                    "max_tokens".to_string(),
                    json!(Self::RECOMMENDED_MAX_TOKENS),
                );
            }
        }

        // 遗留 K2 Thinking 不使用 enable_thinking 参数
        // 思维链通过 reasoning_content 字段自动返回

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // K2.5+ 已在 apply_reasoning_config 中移除锁死参数
        // 遗留 K2 Thinking 需要特殊处理 temperature，不移除
        if Self::is_k25_or_later(&config.model) || Self::is_k3_or_later(&config.model) {
            return true;
        }
        false
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // Kimi 使用 reasoning_content 字段（DeepSeek 风格）；
        // K2.5+/K2.6/K2.7 工具调用链内必须回传 reasoning_content
        if Self::is_thinking_model(&config.model) || config.is_reasoning {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_model_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 遗留 Thinking 模型强制 temperature = 1.0
        assert_eq!(body.get("temperature"), Some(&json!(1.0)));
    }

    #[test]
    fn test_thinking_model_min_max_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-thinking".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(4096)); // 太小

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该被提升到推荐值
        assert_eq!(body.get("max_tokens"), Some(&json!(32000)));
    }

    #[test]
    fn test_non_thinking_model_keeps_temperature() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-turbo-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非 Thinking 遗留模型保持原有 temperature
        assert_eq!(body.get("temperature"), Some(&json!(0.7)));
    }

    // ========== 版本解析测试 ==========

    #[test]
    fn test_parse_k_version() {
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2.5"), Some((2, 5)));
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2-5"), Some((2, 5)));
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2.6"), Some((2, 6)));
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.7-code"),
            Some((2, 7))
        );
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.7-code-highspeed"),
            Some((2, 7))
        );
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k2"), Some((2, 0)));
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2-thinking"),
            Some((2, 0))
        );
        // 快照日期后缀不是小版本号
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2-0905-preview"),
            Some((2, 0))
        );
        // 未来版本
        assert_eq!(
            MoonshotAdapter::parse_k_version("kimi-k2.10"),
            Some((2, 10))
        );
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-k3"), Some((3, 0)));
        // 非 K 系模型
        assert_eq!(MoonshotAdapter::parse_k_version("moonshot-v1-128k"), None);
        assert_eq!(MoonshotAdapter::parse_k_version("kimi-latest"), None);
    }

    #[test]
    fn test_k25_model_detection() {
        // K2.5 及以上（含未来版本）
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2-5"));
        assert!(MoonshotAdapter::is_k25_or_later("Pro/moonshot/kimi-k2.5"));
        assert!(MoonshotAdapter::is_k25_or_later("moonshot/K2.5-preview"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.6"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.7-code"));
        assert!(MoonshotAdapter::is_k25_or_later("kimi-k2.10"));

        // K3+ 走独立路径（is_k3_or_later），不属于 K2.x 新代际
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k3"));
        assert!(MoonshotAdapter::is_k3_or_later("kimi-k3"));
        assert!(MoonshotAdapter::is_k3_or_later("kimi-k3-0905-preview"));
        assert!(!MoonshotAdapter::is_k3_or_later("kimi-k2.7-code"));

        // 旧代际不命中
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2"));
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2-thinking"));
        assert!(!MoonshotAdapter::is_k25_or_later("kimi-k2-0905-preview"));
        assert!(!MoonshotAdapter::is_k25_or_later("moonshot-v1-128k"));
    }

    // ========== K2.5+ 新代际测试用例 ==========

    #[test]
    fn test_k25_thinking_param_format() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 应使用 thinking 参数格式
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_k25_thinking_disabled() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        // K2.5 禁用 thinking
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_k26_fixed_params_stripped() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.8));
        body.insert("n".to_string(), json!(2));
        body.insert("presence_penalty".to_string(), json!(0.5));
        body.insert("frequency_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // K2.6 锁死采样参数，传非固定值直接报错，应全部移除
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("n").is_none());
        assert!(body.get("presence_penalty").is_none());
        assert!(body.get("frequency_penalty").is_none());
        // 默认开启思考
        assert_eq!(
            body.get("thinking").and_then(|v| v.get("type")),
            Some(&json!("enabled"))
        );
    }

    #[test]
    fn test_k26_max_tokens_migrated_to_max_completion_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(50000));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // max_tokens 已废弃：迁移为 max_completion_tokens，不能两字段并存
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(50000)));
    }

    #[test]
    fn test_k25_default_max_completion_tokens() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 未指定时默认 max_completion_tokens = 32768（官方默认值过小）
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(32768)));
    }

    #[test]
    fn test_k26_existing_max_completion_tokens_kept() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_completion_tokens".to_string(), json!(65536));
        body.insert("max_tokens".to_string(), json!(4096));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 已有 max_completion_tokens 优先，废弃的 max_tokens 被移除
        assert!(!body.contains_key("max_tokens"));
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(65536)));
    }

    #[test]
    fn test_k26_keep_all_with_include_thoughts() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.6 可选 Preserved Thinking：include_thoughts 时携带 keep: "all"
        assert_eq!(
            body.get("thinking"),
            Some(&json!({"type": "enabled", "keep": "all"}))
        );
    }

    #[test]
    fn test_k25_no_keep_support() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.5".to_string(),
            include_thoughts: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // K2.5 不支持 keep 参数
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_k27_code_forces_thinking_and_keep_all() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.7-code".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        // 即使外部尝试禁用，K2.7-code 也强制思考 + keep: "all"
        adapter.apply_reasoning_config(&mut body, &config, Some(false));

        assert_eq!(
            body.get("thinking"),
            Some(&json!({"type": "enabled", "keep": "all"}))
        );
    }

    #[test]
    fn test_k26_tool_choice_constraint() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2.6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("tool_choice".to_string(), json!("required")); // 不支持

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // thinking 模式下 tool_choice 应被强制为 auto
        assert_eq!(body.get("tool_choice"), Some(&json!("auto")));
    }

    #[test]
    fn test_new_gen_passback_policy() {
        let adapter = MoonshotAdapter;
        for model in ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"] {
            let config = ApiConfig {
                model: model.to_string(),
                ..Default::default()
            };
            // 新代际统一使用 DeepSeekStyle 回传策略
            assert_eq!(
                adapter.get_passback_policy(&config),
                PassbackPolicy::DeepSeekStyle,
                "model: {}",
                model
            );
        }
    }

    // ========== K3+ 测试用例 ==========

    #[test]
    fn test_k3_forces_reasoning_effort_max() {
        let adapter = MoonshotAdapter;
        for model in [
            "kimi-k3",
            "kimi-k3-0905-preview",
            "moonshotai/Kimi-K3-Instruct",
        ] {
            let config = ApiConfig {
                model: model.to_string(),
                ..Default::default()
            };
            let mut body = Map::new();
            body.insert("thinking".to_string(), json!({"type": "enabled"}));
            body.insert("enable_thinking".to_string(), json!(false));
            body.insert("thinking_budget".to_string(), json!(8192));

            // 即使外部尝试禁用，K3 推理也不可关闭（与前端 canDisable=false 对齐）
            let handled = adapter.apply_reasoning_config(&mut body, &config, Some(false));

            assert!(handled, "model: {}", model);
            // 服务端拒绝 K2.x thinking 对象，必须整体移除
            assert!(!body.contains_key("thinking"), "model: {}", model);
            assert!(!body.contains_key("enable_thinking"), "model: {}", model);
            assert!(!body.contains_key("thinking_budget"), "model: {}", model);
            assert_eq!(
                body.get("reasoning_effort"),
                Some(&json!("max")),
                "model: {}",
                model
            );
        }
    }

    #[test]
    fn test_legacy_k2_not_treated_as_new_gen() {
        let adapter = MoonshotAdapter;
        let config = ApiConfig {
            model: "kimi-k2-0905-preview".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        let early_return = adapter.apply_reasoning_config(&mut body, &config, None);

        // 遗留快照模型不走新代际路径，采样参数保留
        assert!(!early_return);
        assert_eq!(body.get("temperature"), Some(&json!(0.7)));
        assert!(!body.contains_key("thinking"));
    }
}
