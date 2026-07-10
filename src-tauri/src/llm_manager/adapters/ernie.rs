//! 百度文心 (ERNIE) / 千帆 v2 专用适配器
//!
//! 面向千帆推理 V2 接口（`https://qianfan.baidubce.com/v2/chat/completions`，
//! Bearer API Key 鉴权）。旧版 V1 文心工场接口（aip.baidubce.com + access_token，
//! 参数 `max_output_tokens`）已停止演进，X1.1 / 5.x 等新模型只在 V2 提供，本适配器不再兼容 V1。
//!
//! ## 参数格式（千帆 v2）
//! - `max_tokens` / `max_completion_tokens`: 原样透传。v2 就用这两个参数
//!   （`max_tokens` 限制最终回答；`max_completion_tokens` 限制思维链+回答且优先。
//!   ERNIE 思考模型例外：其 `max_tokens` 即限制 reasoning+content 总和）。
//!   **没有** `max_output_tokens`（那是旧 v1 参数），不做改名。
//! - `thinking: {"type": "enabled" | "disabled"}`: 思考开关（**默认 disabled**，
//!   与豆包"默认开思考"相反），本适配器按配置写入。
//! - `thinking_budget`: 仅百度托管的 DeepSeek 等部分模型支持，
//!   **ERNIE 系列思考模型不支持**——按模型名区分，ERNIE 上剥离该字段但保留 thinking 开关。
//! - `reasoning_effort`: 千帆实际取值 `high`（默认）/ `max`；low/medium 由服务端映射为 high。
//! - `penalty_score`: 重复惩罚参数（v2 保留），范围 [1.0, 2.0]。
//!
//! ## 支持的推理模型
//! - ERNIE 5.0 Thinking 系列：`ernie-5.0-thinking-latest`, `ernie-5.0-thinking-preview`
//! - ERNIE X1 系列：`ernie-x1`, `ernie-x1.1`, `ernie-x1-turbo`
//! - 千帆托管 DeepSeek：`deepseek-v4-pro/flash`, `deepseek-v3.2-think` 等（允许 thinking_budget）
//!
//! ## 输出
//! - 思维链在 `reasoning_content`（流式 `delta.reasoning_content`），DeepSeek 兼容
//!
//! 参考文档：
//! - 千帆 v2 文本生成 API：https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb
//! - 千帆模型列表：https://cloud.baidu.com/doc/qianfan-docs/s/7m95lyy43

use super::{get_trimmed_effort, resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// 百度文心 ERNIE / 千帆 v2 专用适配器
///
/// - thinking.type: enabled | disabled（千帆默认 disabled）
/// - thinking_budget: 仅托管 DeepSeek 系保留，ERNIE 系剥离
/// - reasoning_effort: low/medium/high/max
/// - penalty_score: 重复惩罚 [1.0, 2.0]
pub struct ErnieAdapter;

impl ErnieAdapter {
    /// 检查是否是 ERNIE 推理模型
    ///
    /// 包括：
    /// - ERNIE 5.0 Thinking 系列
    /// - ERNIE X1/X1.1 系列（深度思考模型）
    fn is_thinking_model(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        // ERNIE 5.0 Thinking 系列
        model_lower.contains("ernie-5.0-thinking")
            || model_lower.contains("ernie-5-thinking")
            || model_lower.contains("ernie5-thinking")
            // ERNIE X1 系列（深度思考模型）
            || model_lower.contains("ernie-x1")
            || model_lower.contains("ernie_x1")
    }

    /// 千帆托管的 DeepSeek 系模型支持 `thinking_budget`；ERNIE 系不支持
    fn supports_thinking_budget(model: &str) -> bool {
        model.to_lowercase().contains("deepseek")
    }
}

impl RequestAdapter for ErnieAdapter {
    fn id(&self) -> &'static str {
        "ernie"
    }

    fn label(&self) -> &'static str {
        "百度文心"
    }

    fn description(&self) -> &'static str {
        "ERNIE/千帆 v2 系列，支持 thinking.type/reasoning_effort/penalty_score 参数"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // 千帆 v2 直接使用 max_tokens / max_completion_tokens，无需改名。
        // （旧实现改名为 v1 的 max_output_tokens，v2 网关不认识该字段，输出上限会静默失效。）

        // 处理 reasoning_effort 参数
        // 千帆实际取值 high（默认）/ max；low/medium 由服务端映射为 high
        if let Some(effort) = get_trimmed_effort(config) {
            let effort_lower = effort.to_lowercase();
            if matches!(effort_lower.as_str(), "low" | "medium" | "high" | "max") {
                body.insert("reasoning_effort".to_string(), json!(effort_lower));
            }
        }

        // 思考开关：千帆 v2 顶层 thinking:{"type":"enabled"/"disabled"}（默认 disabled）。
        // 不再删除思考参数——旧实现把 thinking/enable_thinking 全删，
        // 导致 ERNIE 5.0-thinking / X1.1 的思考控制完全失效。
        let can_think =
            Self::is_thinking_model(&config.model) || config.supports_reasoning || config.is_reasoning;
        if can_think {
            let thinking_enabled = resolve_enable_thinking(config, enable_thinking);
            body.insert(
                "thinking".to_string(),
                json!({
                    "type": if thinking_enabled { "enabled" } else { "disabled" }
                }),
            );
            // thinking 对象已表达开关语义，移除裸布尔避免重复/冲突
            body.remove("enable_thinking");
        }

        // thinking_budget：ERNIE 系不支持（会被拒或被忽略），剥离；
        // 百度托管 DeepSeek 系支持，保留透传
        if !Self::supports_thinking_budget(&config.model) {
            body.remove("thinking_budget");
        }

        false // 继续处理通用参数
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // ERNIE 推理模型可能需要移除采样参数
        Self::is_thinking_model(&config.model) || config.is_reasoning || config.supports_reasoning
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // ERNIE 推理模型可能使用 DeepSeek 风格的 reasoning_content
        if Self::is_thinking_model(&config.model)
            || config.supports_reasoning
            || config.is_reasoning
        {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }

    fn apply_common_params(&self, body: &mut Map<String, Value>, config: &ApiConfig) {
        // ERNIE 支持部分通用参数
        if let Some(min_p) = config.min_p {
            body.insert("min_p".to_string(), json!(min_p));
        }
        if let Some(top_k) = config.top_k {
            body.insert("top_k".to_string(), json!(top_k));
        }
        // ERNIE 使用 penalty_score 而非 repetition_penalty
        if let Some(rep_penalty) = config.repetition_penalty {
            body.insert("penalty_score".to_string(), json!(rep_penalty));
        }
        // reasoning_effort 已在 apply_reasoning_config 中处理
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_max_tokens_passthrough() {
        let adapter = ErnieAdapter;
        let config = ApiConfig::default();
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(4096));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 千帆 v2 就用 max_tokens，不应改名为 v1 的 max_output_tokens
        assert_eq!(body.get("max_tokens"), Some(&json!(4096)));
        assert!(!body.contains_key("max_output_tokens"));
    }

    #[test]
    fn test_max_completion_tokens_passthrough() {
        let adapter = ErnieAdapter;
        let config = ApiConfig::default();
        let mut body = Map::new();
        body.insert("max_completion_tokens".to_string(), json!(8192));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // v2 的 max_completion_tokens（限思维链+回答、优先级更高）原样透传
        assert_eq!(body.get("max_completion_tokens"), Some(&json!(8192)));
        assert!(!body.contains_key("max_output_tokens"));
    }

    #[test]
    fn test_reasoning_effort() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("high".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_reasoning_effort_max_accepted() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("max".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 千帆实际取值 high/max，max 不能再被白名单丢弃
        assert_eq!(body.get("reasoning_effort"), Some(&json!("max")));
    }

    #[test]
    fn test_reasoning_effort_case_insensitive() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("HIGH".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 应该转换为小写
        assert_eq!(body.get("reasoning_effort"), Some(&json!("high")));
    }

    #[test]
    fn test_invalid_reasoning_effort_ignored() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            reasoning_effort: Some("invalid".to_string()),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 无效值应该被忽略
        assert!(!body.contains_key("reasoning_effort"));
    }

    #[test]
    fn test_thinking_switch_enabled() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-x1.1".to_string(),
            thinking_enabled: true,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // v2 思考开关：thinking:{"type":"enabled"}
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_thinking_switch_disabled() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0-thinking-latest".to_string(),
            thinking_enabled: false,
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // ERNIE 默认关闭思考，显式 disabled 也应能表达
        assert_eq!(body.get("thinking"), Some(&json!({"type": "disabled"})));
    }

    #[test]
    fn test_turn_level_thinking_override() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-x1.1".to_string(),
            thinking_enabled: false,
            ..Default::default()
        };
        let mut body = Map::new();

        // 本轮显式启用应覆盖配置
        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_enable_thinking_bool_converted_to_thinking_object() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            supports_reasoning: true,
            thinking_enabled: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("enable_thinking".to_string(), json!(true));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // 裸布尔被 thinking 对象取代，开关语义保留
        assert!(!body.contains_key("enable_thinking"));
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_thinking_budget_stripped_for_ernie() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-x1.1".to_string(),
            thinking_enabled: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("thinking_budget".to_string(), json!(2048));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // ERNIE 系不支持 thinking_budget，剥离；但 thinking 开关保留
        assert!(!body.contains_key("thinking_budget"));
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_thinking_budget_kept_for_hosted_deepseek() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "deepseek-v3.2-think".to_string(),
            supports_reasoning: true,
            thinking_enabled: true,
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("thinking_budget".to_string(), json!(4096));

        adapter.apply_reasoning_config(&mut body, &config, Some(true));

        // 百度托管 DeepSeek 支持 thinking_budget，保留透传
        assert_eq!(body.get("thinking_budget"), Some(&json!(4096)));
        assert_eq!(body.get("thinking"), Some(&json!({"type": "enabled"})));
    }

    #[test]
    fn test_non_thinking_model_no_thinking_param() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-4.5-turbo-128k".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        // 非思考模型不注入 thinking 参数
        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_is_thinking_model() {
        assert!(ErnieAdapter::is_thinking_model("ernie-5.0-thinking-latest"));
        assert!(ErnieAdapter::is_thinking_model(
            "ernie-5.0-thinking-preview"
        ));
        assert!(ErnieAdapter::is_thinking_model("ERNIE-5.0-THINKING-LATEST"));
        assert!(ErnieAdapter::is_thinking_model("ernie-x1.1"));
        assert!(!ErnieAdapter::is_thinking_model("ernie-5.0"));
        assert!(!ErnieAdapter::is_thinking_model("ernie-4.0"));
    }

    #[test]
    fn test_should_remove_sampling_params_for_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0-thinking-latest".to_string(),
            ..Default::default()
        };

        assert!(adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_keep_sampling_params_for_non_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0".to_string(),
            is_reasoning: false,
            supports_reasoning: false,
            ..Default::default()
        };

        assert!(!adapter.should_remove_sampling_params(&config));
    }

    #[test]
    fn test_passback_policy_for_thinking_model() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            model: "ernie-5.0-thinking-latest".to_string(),
            ..Default::default()
        };

        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_penalty_score_conversion() {
        let adapter = ErnieAdapter;
        let config = ApiConfig {
            repetition_penalty: Some(1.2),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_common_params(&mut body, &config);

        // ERNIE 使用 penalty_score。
        // 注意：repetition_penalty 是 f32，经 serde_json 提升为 f64 会带精度尾数
        //（1.2f32 as f64 = 1.2000000476837158），按同样方式构造期望值。
        assert_eq!(body.get("penalty_score"), Some(&json!(1.2f32 as f64)));
        assert!(!body.contains_key("repetition_penalty"));
    }
}
