//! Anthropic/Claude 专用适配器
//!
//! ## thinking 请求形态按代际分叉（2026-07，研报 02）
//! - **旧代际（manual extended thinking）**：Haiku 4.5、Sonnet 4.5、Opus 4.5 及更早——
//!   发送 `thinking: {type:"enabled", budget_tokens:N}`，N >= 1024 且 < max_tokens。
//! - **新代际（adaptive thinking）**：Opus/Sonnet 4.6+、Opus/Sonnet 5、Fable 5、
//!   限量开放的 Mythos 5 及未来默认——
//!   发送 `thinking: {type:"adaptive"}`（可选 `display`）+ `output_config: {effort}`；
//!   传 `enabled` 会直接 **400**。
//!
//! ## 采样参数限制
//! - 新代际对非默认 `temperature` / `top_p` / `top_k` **一律 400**（与 thinking 开关无关），
//!   必须无条件剥离。
//! - 旧代际 Extended Thinking 模式：temperature/top_k 必须移除，top_p 限 0.95-1.0。
//! - Claude 4.5（非 thinking 模式）：temperature 和 top_p 互斥，优先 temperature。
//! - 全系不支持 frequency_penalty / presence_penalty。
//!
//! 参考文档：
//! - https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
//! - https://platform.claude.com/docs/en/build-with-claude/extended-thinking

use super::{get_trimmed_effort, resolve_enable_thinking, PassbackPolicy, RequestAdapter};
use crate::llm_manager::ApiConfig;
use serde_json::{json, Map, Value};

/// Anthropic/Claude 专用适配器
///
/// 按模型代际生成不同的 thinking 请求形态（见模块文档）。
pub struct AnthropicAdapter;

/// 旧代际 budget_tokens 的上限（官方建议超过 32k 使用 batch processing）
const MAX_BUDGET_TOKENS: i32 = 32768;

/// budget_tokens 的下限
const MIN_BUDGET_TOKENS: i32 = 1024;

/// 默认 budget_tokens
const DEFAULT_BUDGET_TOKENS: i32 = 10240;

/// Claude 模型代际（决定 thinking 请求形态与采样参数策略）
///
/// 集中式判定，替代旧的 `supports_extended_thinking` / `is_claude_45` 零散子串匹配
/// （教训：`claude-opus-4-8` 会被 `contains("claude-opus-4")` 误判为旧代际）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeGeneration {
    /// 2026 新代际：thinking 只接受 `{type:"adaptive"}` + `output_config.effort`，
    /// 对非默认 temperature/top_p/top_k 一律 400。
    /// 覆盖：Opus 4.7/4.8、Opus/Sonnet 5、Fable/Mythos 5 及未来更高版本。
    Adaptive,
    /// 旧代际 manual extended thinking：`{type:"enabled", budget_tokens}`。
    /// 覆盖：Opus/Sonnet 4 ~ 4.5、Haiku 4.x、Sonnet 3.7。
    Manual,
    /// 不支持 extended thinking（Claude 3.5/3 及更早，或无法识别的模型）。
    Unsupported,
}

/// 解析 Claude 模型 ID 中的（家族, 主版本, 次版本）
///
/// 兼容的 ID 形态：
/// - `claude-opus-4-8` / `claude-sonnet-5` / `claude-fable-5` / `claude-mythos-5`
/// - `claude-sonnet-4-5-20250929` / `claude-haiku-4-5-20251001`（日期快照）
/// - `claude-opus-4.5` / `claude-4.5-sonnet`（点号 / 版本前置变体）
/// - `claude-3-7-sonnet`（版本前置）
/// - `anthropic.claude-opus-4-8`（Bedrock mantle）/ `claude-sonnet-4-5@20250929`（Vertex）
fn parse_claude_model(model: &str) -> Option<(&'static str, u32, Option<u32>)> {
    const FAMILIES: &[&str] = &["opus", "sonnet", "haiku", "fable", "mythos"];

    let normalized = model.to_lowercase();
    let tokens: Vec<&str> = normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();

    let family_idx = tokens.iter().position(|t| FAMILIES.contains(t))?;
    let family = FAMILIES
        .iter()
        .copied()
        .find(|f| *f == tokens[family_idx])?;

    // 版本 token 过滤：>= 100 视为日期快照后缀（如 20250929），不是版本号
    let as_version = |t: &str| t.parse::<u32>().ok().filter(|v| *v < 100);

    // 优先解析家族后置版本（claude-opus-4-8）
    if let Some(major) = tokens.get(family_idx + 1).and_then(|t| as_version(t)) {
        let minor = tokens.get(family_idx + 2).and_then(|t| as_version(t));
        return Some((family, major, minor));
    }

    // 版本前置形态（claude-3-7-sonnet / claude-4.5-sonnet）：向前找连续数字 token
    let mut nums: Vec<u32> = Vec::new();
    let mut i = family_idx;
    while i > 0 {
        i -= 1;
        match as_version(tokens[i]) {
            Some(n) => nums.push(n),
            None => break,
        }
    }
    nums.reverse();
    if let Some(&major) = nums.first() {
        return Some((family, major, nums.get(1).copied()));
    }

    // 家族存在但无版本号（如裸 "claude-sonnet"）
    Some((family, 0, None))
}

/// 集中式 Claude 代际判定
pub fn claude_generation(model: &str) -> ClaudeGeneration {
    let Some((family, major, minor)) = parse_claude_model(model) else {
        return ClaudeGeneration::Unsupported;
    };
    match family {
        // Fable / restricted Mythos 全系 adaptive（且 always-on）
        "fable" | "mythos" => ClaudeGeneration::Adaptive,
        "opus" => match (major, minor) {
            (0, _) => ClaudeGeneration::Unsupported,
            (m, _) if m >= 5 => ClaudeGeneration::Adaptive,
            (4, Some(n)) if n >= 6 => ClaudeGeneration::Adaptive,
            // Opus 4 / 4.1 / 4.5：manual
            (4, _) => ClaudeGeneration::Manual,
            _ => ClaudeGeneration::Unsupported,
        },
        "sonnet" => match (major, minor) {
            (0, _) => ClaudeGeneration::Unsupported,
            (m, _) if m >= 5 => ClaudeGeneration::Adaptive,
            (4, Some(n)) if n >= 6 => ClaudeGeneration::Adaptive,
            (4, _) => ClaudeGeneration::Manual,
            (3, Some(7)) => ClaudeGeneration::Manual,
            _ => ClaudeGeneration::Unsupported,
        },
        "haiku" => match (major, minor) {
            (0, _) => ClaudeGeneration::Unsupported,
            (4, _) => ClaudeGeneration::Manual,
            _ => ClaudeGeneration::Unsupported,
        },
        _ => ClaudeGeneration::Unsupported,
    }
}

/// Fable 5 / restricted Mythos 5 的 thinking 为 always-on，不接受 `{type:"disabled"}`
pub fn claude_thinking_always_on(model: &str) -> bool {
    matches!(parse_claude_model(model), Some(("fable" | "mythos", _, _)))
}

/// 将 reasoning_effort 配置映射为 Anthropic `output_config.effort`（新代际）
///
/// 合法取值：low / medium / high / xhigh / max（研报 02 §3.1）
pub fn map_reasoning_effort_to_anthropic(effort: &str) -> Option<&'static str> {
    match effort.trim().to_lowercase().as_str() {
        "low" | "minimal" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// budget_tokens → effort 的近似映射（仅在未配置 reasoning_effort 时使用）
pub fn map_budget_tokens_to_effort(budget: i32) -> &'static str {
    if budget < 8192 {
        "low"
    } else if budget < 16384 {
        "medium"
    } else if budget < 32768 {
        "high"
    } else {
        "max"
    }
}

impl AnthropicAdapter {
    /// 检查是否是 Claude 4.5 系列（有 temperature/top_p 互斥限制）
    fn is_claude_45(model: &str) -> bool {
        matches!(
            parse_claude_model(model),
            Some(("opus" | "sonnet" | "haiku", 4, Some(5)))
        )
    }

    /// 旧代际 manual thinking 的 budget_tokens 上限。
    fn manual_budget_cap(_model: &str) -> i32 {
        MAX_BUDGET_TOKENS
    }

    /// 限制 top_p 到 Extended Thinking 允许的范围 (0.95-1.0)
    fn clamp_top_p_for_thinking(top_p: f64) -> f64 {
        top_p.clamp(0.95, 1.0)
    }

    /// 验证并限制 budget_tokens（旧代际 manual thinking）
    ///
    /// 规则：
    /// - 最小值：1024
    /// - 最大值：32768（4.6+ 已走 adaptive effort）
    /// - 必须小于 max_tokens（如果提供）
    fn validate_budget_tokens(
        budget: Option<i32>,
        max_tokens: Option<i32>,
        budget_cap: i32,
    ) -> i32 {
        let budget = budget.filter(|&b| b > 0).unwrap_or(DEFAULT_BUDGET_TOKENS);

        // 应用上下限
        let mut validated = budget.max(MIN_BUDGET_TOKENS).min(budget_cap);

        // 确保 budget_tokens < max_tokens
        if let Some(max) = max_tokens {
            if max <= 1 {
                // max_tokens 太小，无法满足 budget_tokens < max_tokens 约束
                validated = 1;
                log::warn!(
                    "[AnthropicAdapter] max_tokens ({}) too small; forcing budget_tokens to {}",
                    max,
                    validated
                );
                return validated;
            }

            if max <= MIN_BUDGET_TOKENS {
                // 无法满足 >=1024 且 < max_tokens 的约束，优先保证 < max_tokens
                validated = (max - 1).max(1);
                log::warn!(
                    "[AnthropicAdapter] max_tokens ({}) <= MIN_BUDGET_TOKENS; using budget_tokens {} below minimum",
                    max, validated
                );
                return validated;
            }

            if validated >= max {
                // budget_tokens 必须小于 max_tokens
                validated = (max - 1).max(MIN_BUDGET_TOKENS);
                log::warn!(
                    "[AnthropicAdapter] budget_tokens ({}) >= max_tokens ({}), clamped to {}",
                    budget,
                    max,
                    validated
                );
            }
        }

        validated
    }

    /// 新代际（adaptive）请求形态：
    /// - 无条件剥离 temperature/top_p/top_k（非默认值一律 400，与 thinking 开关无关）
    /// - thinking 开启：`thinking:{type:"adaptive"[, display]}` + `output_config.effort`
    /// - thinking 关闭：显式 `thinking:{type:"disabled"}`（Sonnet 5 默认开启，需显式关闭；
    ///   Fable always-on 不发送 disabled）
    fn apply_adaptive_generation(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking_value: bool,
    ) {
        body.remove("temperature");
        body.remove("top_p");
        body.remove("top_k");

        if enable_thinking_value {
            let mut thinking = Map::new();
            thinking.insert("type".to_string(), json!("adaptive"));
            // 新代际默认 display:"omitted"（不返回思考文本，只有加密 signature）。
            // 用户希望显示思考文本时按研报 02 显式传 display:"summarized"
            if config.include_thoughts {
                thinking.insert("display".to_string(), json!("summarized"));
            }
            body.insert("thinking".to_string(), Value::Object(thinking));

            // effort 来源优先级：
            // 1. reasoning_effort 直接映射（low/medium/high/xhigh/max，minimal→low）
            // 2. Claude 专属 effort 字段（历史通道）
            // 3. 只有 thinking_budget 时做近似映射
            // 4. 都没有则不发 effort，使用服务端默认
            let effort = get_trimmed_effort(config)
                .and_then(map_reasoning_effort_to_anthropic)
                .or_else(|| {
                    config
                        .effort
                        .as_deref()
                        .and_then(map_reasoning_effort_to_anthropic)
                })
                .or_else(|| {
                    config
                        .thinking_budget
                        .filter(|b| *b > 0)
                        .map(map_budget_tokens_to_effort)
                });
            if let Some(effort) = effort {
                body.insert("effort".to_string(), json!(effort));
            } else {
                body.remove("effort");
            }
        } else if !claude_thinking_always_on(&config.model) {
            body.insert("thinking".to_string(), json!({ "type": "disabled" }));
            body.remove("effort");
        }
    }

    /// 旧代际（manual extended thinking）请求形态：保留原有 enabled+budget_tokens 逻辑
    fn apply_manual_generation(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking_value: bool,
        generation: ClaudeGeneration,
    ) {
        if enable_thinking_value {
            // ========== Extended Thinking 模式采样参数限制 ==========
            // - temperature: 必须移除（不兼容）
            // - top_k: 必须移除（不兼容）
            // - top_p: 可选，但必须在 0.95-1.0 范围内
            if body.contains_key("temperature") {
                body.remove("temperature");
                log::debug!(
                    "[AnthropicAdapter] Extended Thinking: removed temperature (not compatible)"
                );
            }

            if body.contains_key("top_k") {
                body.remove("top_k");
                log::debug!("[AnthropicAdapter] Extended Thinking: removed top_k (not compatible)");
            }

            if let Some(top_p) = body.get("top_p").and_then(|v| v.as_f64()) {
                if !(0.95..=1.0).contains(&top_p) {
                    let clamped = Self::clamp_top_p_for_thinking(top_p);
                    body.insert("top_p".to_string(), json!(clamped));
                    log::debug!(
                        "[AnthropicAdapter] Extended Thinking: clamped top_p from {} to {} (allowed: 0.95-1.0)",
                        top_p, clamped
                    );
                }
            }

            if generation == ClaudeGeneration::Unsupported {
                log::warn!(
                    "[AnthropicAdapter] ⚠️ Model {} may not support Extended Thinking. \
                     Manual thinking models: Claude Opus/Sonnet 4.x(≤4.5), Haiku 4.5, Sonnet 3.7",
                    config.model
                );
            }

            // 从请求体获取 max_tokens（用于验证 budget_tokens < max_tokens）
            let max_tokens = body
                .get("max_tokens")
                .or_else(|| body.get("max_completion_tokens"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            let budget_tokens = Self::validate_budget_tokens(
                config.thinking_budget,
                max_tokens,
                Self::manual_budget_cap(&config.model),
            );

            let thinking = json!({
                "type": "enabled",
                "budget_tokens": budget_tokens as u32
            });
            body.insert("thinking".to_string(), thinking);
        } else {
            // ========== 非 Extended Thinking 模式 ==========
            // Claude 4.5: temperature 和 top_p 互斥，优先使用 temperature
            if Self::is_claude_45(&config.model) {
                let has_temperature = body.contains_key("temperature");
                let has_top_p = body.contains_key("top_p");

                if has_temperature && has_top_p {
                    body.remove("top_p");
                    log::debug!("[AnthropicAdapter] Claude 4.5: removed top_p (mutually exclusive with temperature)");
                }
            }
        }
    }
}

impl RequestAdapter for AnthropicAdapter {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn label(&self) -> &'static str {
        "Anthropic Claude"
    }

    fn description(&self) -> &'static str {
        "Claude 系列，thinking 请求形态按代际分叉（manual budget / adaptive effort）"
    }

    fn apply_reasoning_config(
        &self,
        body: &mut Map<String, Value>,
        config: &ApiConfig,
        enable_thinking: Option<bool>,
    ) -> bool {
        // Claude 不支持 frequency_penalty 和 presence_penalty
        body.remove("frequency_penalty");
        body.remove("presence_penalty");

        let enable_thinking_value = resolve_enable_thinking(config, enable_thinking);
        let generation = claude_generation(&config.model);

        if generation == ClaudeGeneration::Adaptive {
            self.apply_adaptive_generation(body, config, enable_thinking_value);
            // 提前返回：跳过 apply_common_params，避免向新代际注入
            // top_k/min_p/repetition_penalty/effort 等会触发 400 或语义不符的参数
            return true;
        }

        self.apply_manual_generation(body, config, enable_thinking_value, generation);
        false
    }

    fn should_remove_sampling_params(&self, config: &ApiConfig) -> bool {
        // 新代际对非默认 temperature/top_p 一律 400（与 thinking 开关无关），
        // 在管线层面提前剥离；旧代际由 apply_reasoning_config 按模式处理
        claude_generation(&config.model) == ClaudeGeneration::Adaptive
    }

    fn get_passback_policy(&self, config: &ApiConfig) -> PassbackPolicy {
        // Anthropic 使用 DeepSeek 风格的思维链回传
        if resolve_enable_thinking(config, None) {
            PassbackPolicy::DeepSeekStyle
        } else {
            PassbackPolicy::NoPassback
        }
    }

    fn format_tool_call_message(
        &self,
        tool_calls: &[Value],
        thinking_content: Option<&str>,
    ) -> Option<Value> {
        // Anthropic 要求：thinking 块必须在 tool_use 块之前
        // 注意：signature 不经过本方法——providers 层会把消息级 thought_signature
        // 附加到 thinking 块（含新代际 display:"omitted" 的空文本块），见
        // providers::convert_assistant_message
        let mut content_blocks = Vec::new();

        // 先添加 thinking 块
        if let Some(thinking) = thinking_content {
            if !thinking.is_empty() {
                content_blocks.push(json!({
                    "type": "thinking",
                    "thinking": thinking
                }));
            }
        }

        // 再添加 tool_use 块
        for tool_call in tool_calls {
            if let Some(tc) = tool_call.as_object() {
                let tool_use = json!({
                    "type": "tool_use",
                    "id": tc.get("id").cloned().unwrap_or(json!("")),
                    "name": tc.get("function").and_then(|f| f.get("name")).cloned().unwrap_or(json!("")),
                    "input": tc.get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(json!({}))
                });
                content_blocks.push(tool_use);
            }
        }

        if content_blocks.is_empty() {
            None
        } else {
            Some(json!(content_blocks))
        }
    }

    fn requires_thinking_in_history(&self, config: &ApiConfig) -> bool {
        // Anthropic 最佳实践：使用 thinking + tool calling 时
        // 必须在发送工具结果时保留之前的 thinking_blocks
        resolve_enable_thinking(config, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== 代际判定测试 ==========

    #[test]
    fn test_claude_generation_new_models_are_adaptive() {
        // 关键教训：claude-opus-4-8 不能被 contains("claude-opus-4") 误判为旧代际
        assert_eq!(
            claude_generation("claude-opus-4-8"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-opus-4-7"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-sonnet-5"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-fable-5"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-mythos-5"),
            ClaudeGeneration::Adaptive
        );
        // 未来默认：更高版本按新代际处理
        assert_eq!(
            claude_generation("claude-opus-5"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-sonnet-5-1"),
            ClaudeGeneration::Adaptive
        );
        // 第三方渠道 ID 形态
        assert_eq!(
            claude_generation("anthropic.claude-opus-4-8"),
            ClaudeGeneration::Adaptive
        );
    }

    #[test]
    fn test_claude_generation_legacy_models_are_manual() {
        assert_eq!(
            claude_generation("claude-opus-4-5-20251101"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-sonnet-4-5-20250929"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-haiku-4-5-20251001"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-opus-4-1"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-sonnet-4"),
            ClaudeGeneration::Manual
        );
        // 4.6 supports legacy manual requests, but the application uses the
        // current adaptive + output_config.effort contract.
        assert_eq!(
            claude_generation("claude-opus-4-6"),
            ClaudeGeneration::Adaptive
        );
        assert_eq!(
            claude_generation("claude-sonnet-4-6"),
            ClaudeGeneration::Adaptive
        );
        // 版本前置 / 点号变体
        assert_eq!(
            claude_generation("claude-3-7-sonnet"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-4.5-sonnet"),
            ClaudeGeneration::Manual
        );
        assert_eq!(
            claude_generation("claude-opus-4.5"),
            ClaudeGeneration::Manual
        );
    }

    #[test]
    fn test_claude_generation_unsupported_models() {
        assert_eq!(
            claude_generation("claude-3-5-sonnet"),
            ClaudeGeneration::Unsupported
        );
        assert_eq!(
            claude_generation("claude-3-opus"),
            ClaudeGeneration::Unsupported
        );
        assert_eq!(claude_generation("gpt-5.2"), ClaudeGeneration::Unsupported);
        assert_eq!(claude_generation(""), ClaudeGeneration::Unsupported);
    }

    #[test]
    fn test_claude_thinking_always_on() {
        assert!(claude_thinking_always_on("claude-fable-5"));
        assert!(claude_thinking_always_on("claude-mythos-5"));
        assert!(!claude_thinking_always_on("claude-sonnet-5"));
        assert!(!claude_thinking_always_on("claude-opus-4-8"));
    }

    // ========== 新代际 adaptive thinking 测试 ==========

    #[test]
    fn test_adaptive_thinking_format_for_new_generation() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            reasoning_effort: Some("xhigh".to_string()),
            model: "claude-opus-4-8".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        let early_return = adapter.apply_reasoning_config(&mut body, &config, None);

        // 新代际跳过 apply_common_params（避免注入 top_k 等）
        assert!(early_return);
        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("adaptive")));
        // 不能带 budget_tokens（enabled 形态专属）
        assert!(thinking.get("budget_tokens").is_none());
        // effort 来自 reasoning_effort 直接映射
        assert_eq!(body.get("effort"), Some(&json!("xhigh")));
    }

    #[test]
    fn test_adaptive_thinking_maps_budget_to_effort_when_no_effort_configured() {
        let adapter = AnthropicAdapter;
        let cases = [
            (4096, "low"),
            (10240, "medium"),
            (20000, "high"),
            (32768, "max"),
        ];
        for (budget, expected) in cases {
            let config = ApiConfig {
                thinking_enabled: true,
                thinking_budget: Some(budget),
                model: "claude-sonnet-5".to_string(),
                ..Default::default()
            };
            let mut body = Map::new();
            adapter.apply_reasoning_config(&mut body, &config, None);
            assert_eq!(
                body.get("effort"),
                Some(&json!(expected)),
                "budget {} should map to {}",
                budget,
                expected
            );
        }
    }

    #[test]
    fn test_adaptive_thinking_omits_effort_when_nothing_configured() {
        // 无 reasoning_effort 也无 budget 时不发 effort，用服务端默认
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-fable-5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(
            body.get("thinking").and_then(|t| t.get("type")),
            Some(&json!("adaptive"))
        );
        assert!(!body.contains_key("effort"));
    }

    #[test]
    fn test_adaptive_thinking_display_param_when_include_thoughts() {
        // 新代际默认 display:"omitted"；用户要求显示思考文本时显式传 summarized
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            include_thoughts: true,
            model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("display"), Some(&json!("summarized")));

        // include_thoughts=false 时不传 display
        let config_no_display = ApiConfig {
            thinking_enabled: true,
            include_thoughts: false,
            model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        let mut body2 = Map::new();
        adapter.apply_reasoning_config(&mut body2, &config_no_display, None);
        assert!(body2.get("thinking").unwrap().get("display").is_none());
    }

    #[test]
    fn test_adaptive_generation_strips_sampling_params_even_without_thinking() {
        // 研报 02 要点 4：新代际对非默认 temperature/top_p/top_k 一律 400（与 thinking 无关）
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-opus-4-8".to_string(),
            ..Default::default()
        };
        assert!(adapter.should_remove_sampling_params(&config));

        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));
        body.insert("top_k".to_string(), json!(40));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("temperature"));
        assert!(!body.contains_key("top_p"));
        assert!(!body.contains_key("top_k"));
    }

    #[test]
    fn test_adaptive_generation_sends_disabled_when_thinking_off() {
        // Sonnet 5 默认开启 adaptive thinking，关闭必须显式传 disabled
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert_eq!(
            body.get("thinking").and_then(|t| t.get("type")),
            Some(&json!("disabled"))
        );
    }

    #[test]
    fn test_fable_always_on_never_sends_disabled() {
        // Fable 5 thinking 不可关闭，发送 disabled 会报错
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-fable-5".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("thinking"));
    }

    #[test]
    fn test_restricted_mythos_5_uses_always_on_adaptive_thinking() {
        let adapter = AnthropicAdapter;
        let enabled = ApiConfig {
            thinking_enabled: true,
            reasoning_effort: Some("xhigh".to_string()),
            model: "claude-mythos-5".to_string(),
            ..Default::default()
        };
        let mut enabled_body = Map::new();
        enabled_body.insert("temperature".to_string(), json!(0.7));

        assert!(adapter.apply_reasoning_config(&mut enabled_body, &enabled, None));
        assert_eq!(enabled_body["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(enabled_body["effort"], json!("xhigh"));
        assert!(!enabled_body.contains_key("temperature"));

        // Mythos is restricted but real and always-on. A local "off" setting
        // must never be translated into the unsupported `{type:"disabled"}`.
        let disabled = ApiConfig {
            thinking_enabled: false,
            model: "claude-mythos-5".to_string(),
            ..Default::default()
        };
        let mut disabled_body = Map::new();
        assert!(adapter.apply_reasoning_config(&mut disabled_body, &disabled, None));
        assert!(!disabled_body.contains_key("thinking"));
    }

    #[test]
    fn test_old_generation_does_not_remove_sampling_params_globally() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            model: "claude-sonnet-4-5".to_string(),
            ..Default::default()
        };
        assert!(!adapter.should_remove_sampling_params(&config));
    }

    // ========== 旧代际 manual thinking 测试（原有行为保留） ==========

    #[test]
    fn test_extended_thinking_format() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(8192),
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("enabled")));
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(8192)));
    }

    #[test]
    fn test_minimum_budget_tokens() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(100), // 低于 1024
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // 应该被提升到 1024
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(1024)));
    }

    #[test]
    fn test_default_budget_tokens() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: None,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // 默认 10240
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(10240)));
    }

    // ========== Extended Thinking 采样参数限制测试 ==========

    #[test]
    fn test_extended_thinking_removes_temperature() {
        // Extended Thinking 模式必须移除 temperature
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // temperature 必须被移除
        assert!(!body.contains_key("temperature"));
        // thinking 应该存在
        assert!(body.contains_key("thinking"));
    }

    #[test]
    fn test_extended_thinking_removes_top_k() {
        // Extended Thinking 模式必须移除 top_k
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_k".to_string(), json!(40));

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_k 必须被移除
        assert!(!body.contains_key("top_k"));
    }

    #[test]
    fn test_extended_thinking_clamps_top_p() {
        // Extended Thinking 模式下 top_p 必须在 0.95-1.0 范围
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.8)); // 低于 0.95

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_p 应该被限制到 0.95
        assert_eq!(body.get("top_p"), Some(&json!(0.95)));
    }

    #[test]
    fn test_extended_thinking_keeps_valid_top_p() {
        // Extended Thinking 模式下，有效范围内的 top_p 应该保留
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.97)); // 在有效范围内

        adapter.apply_reasoning_config(&mut body, &config, None);

        // top_p 应该保持不变
        assert_eq!(body.get("top_p"), Some(&json!(0.97)));
    }

    #[test]
    fn test_budget_tokens_upper_limit() {
        // 旧代际 budget_tokens 应该被限制到 32768
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(50000), None, MAX_BUDGET_TOKENS);
        assert_eq!(validated, 32768);
    }

    #[test]
    fn test_46_generation_uses_adaptive_effort() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            reasoning_effort: Some("max".to_string()),
            model: "claude-opus-4-6".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        adapter.apply_reasoning_config(&mut body, &config, None);
        let thinking = body.get("thinking").unwrap();
        assert_eq!(thinking.get("type"), Some(&json!("adaptive")));
        assert!(thinking.get("budget_tokens").is_none());
        assert_eq!(body.get("effort"), Some(&json!("max")));
    }

    #[test]
    fn test_budget_tokens_lower_limit() {
        // budget_tokens 应该被提升到 1024
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(500), None, MAX_BUDGET_TOKENS);
        assert_eq!(validated, 1024);
    }

    #[test]
    fn test_budget_tokens_less_than_max_tokens() {
        // budget_tokens 必须小于 max_tokens
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(10000), Some(8000), MAX_BUDGET_TOKENS);
        // 10000 >= 8000，应该被限制到 max_tokens - 1 = 7999
        assert_eq!(validated, 7999);
    }

    #[test]
    fn test_budget_tokens_valid_range() {
        // 有效范围内的 budget_tokens 应该保持不变
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(8192), Some(16000), MAX_BUDGET_TOKENS);
        assert_eq!(validated, 8192);
    }

    #[test]
    fn test_budget_tokens_with_body_max_tokens() {
        // 测试从请求体获取 max_tokens 的场景
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: true,
            thinking_budget: Some(20000), // 大于 max_tokens
            model: "claude-sonnet-4".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("max_tokens".to_string(), json!(16000)); // max_tokens = 16000

        adapter.apply_reasoning_config(&mut body, &config, None);

        let thinking = body.get("thinking").unwrap();
        // budget_tokens 应该被限制到 15999 (max_tokens - 1)
        assert_eq!(thinking.get("budget_tokens"), Some(&json!(15999)));
    }

    #[test]
    fn test_budget_tokens_when_max_tokens_too_small() {
        // max_tokens 太小时，预算应降级到 max_tokens - 1
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(5000), Some(512), MAX_BUDGET_TOKENS);
        assert_eq!(validated, 511);
    }

    #[test]
    fn test_budget_tokens_when_max_tokens_is_one() {
        // max_tokens <= 1 时无法满足约束，使用最小可用值
        let validated =
            AnthropicAdapter::validate_budget_tokens(Some(5000), Some(1), MAX_BUDGET_TOKENS);
        assert_eq!(validated, 1);
    }

    #[test]
    fn test_enable_thinking_override_controls_history_and_passback() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            enable_thinking: Some(true),
            model: "claude-sonnet-4-5".to_string(),
            ..Default::default()
        };

        assert_eq!(
            adapter.get_passback_policy(&config),
            PassbackPolicy::DeepSeekStyle
        );
        assert!(adapter.requires_thinking_in_history(&config));
    }

    // ========== 非 Extended Thinking 模式测试 ==========

    #[test]
    fn test_claude_45_temperature_top_p_mutual_exclusion() {
        // 非 thinking 模式下，Claude 4.5 的 temperature 和 top_p 互斥
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false, // 非 thinking 模式
            model: "claude-sonnet-4-5-20250929".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("temperature"));
        assert!(!body.contains_key("top_p"));
    }

    #[test]
    fn test_claude_45_removes_penalty_params() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            model: "claude-4.5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("presence_penalty"));
    }

    #[test]
    fn test_older_claude_keeps_top_p_with_temperature() {
        // 非 thinking 模式，非 4.5 模型，保留两个参数
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-3-5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("temperature".to_string(), json!(0.7));
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("temperature"));
        assert!(body.contains_key("top_p"));
    }

    #[test]
    fn test_claude_45_keeps_top_p_when_no_temperature() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            thinking_enabled: false,
            model: "claude-4.5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("top_p".to_string(), json!(0.9));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(body.contains_key("top_p"));
        assert!(!body.contains_key("temperature"));
    }

    #[test]
    fn test_older_claude_also_removes_penalty_params() {
        let adapter = AnthropicAdapter;
        let config = ApiConfig {
            model: "claude-3-5-sonnet".to_string(),
            ..Default::default()
        };
        let mut body = Map::new();
        body.insert("frequency_penalty".to_string(), json!(0.5));
        body.insert("presence_penalty".to_string(), json!(0.5));

        adapter.apply_reasoning_config(&mut body, &config, None);

        assert!(!body.contains_key("frequency_penalty"));
        assert!(!body.contains_key("presence_penalty"));
    }

    #[test]
    fn test_is_claude_45_version_aware() {
        // 4.5 系列精确识别
        assert!(AnthropicAdapter::is_claude_45("claude-opus-4.5"));
        assert!(AnthropicAdapter::is_claude_45("claude-opus-4-5"));
        assert!(AnthropicAdapter::is_claude_45("claude-opus-4-5-20251101"));
        assert!(AnthropicAdapter::is_claude_45("claude-sonnet-4.5"));
        assert!(AnthropicAdapter::is_claude_45("claude-haiku-4.5"));

        // 非 4.5 模型（尤其 4-8 不能被子串误判）
        assert!(!AnthropicAdapter::is_claude_45("claude-sonnet-4"));
        assert!(!AnthropicAdapter::is_claude_45("claude-opus-4"));
        assert!(!AnthropicAdapter::is_claude_45("claude-opus-4-8"));
        assert!(!AnthropicAdapter::is_claude_45("claude-3-5-sonnet"));
    }
}
