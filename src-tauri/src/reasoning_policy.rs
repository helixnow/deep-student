//! 思维链回传策略模块
//!
//! 将"是否需要回传思维链"的判断逻辑收敛到单一文件。
//!
//! ## 设计文档
//! 参考：`src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md` 第 7 节
//!
//! ## 支持的模型
//! | 模型/Provider | 格式 | 需要回传 | 新问题清理 | 签名 |
//! |--------------|------|---------|-----------|------|
//! | DeepSeek R1/Reasoner | `reasoning_content` | ✅ | ✅ | ❌ |
//! | DeepSeek V3.x (enable_thinking) | `reasoning_content` | ✅ | ✅ | ❌ |
//! | Perplexity Sonar Reasoning | `reasoning_content` | ✅ | ✅ | ❌ |
//! | xAI Grok | `reasoning_content` | ✅ | ✅ | ❌ |
//! | GLM-4-Thinking (SiliconFlow) | `reasoning_content` | ✅ | ✅ | ❌ |
//! | Kimi K2-Thinking (官方/第三方) | `reasoning_content` | ✅ | ✅ | ❌ |
//! | Kimi K2.5 (官方/第三方) | `reasoning_content` | ✅ | ✅ | ❌ |
//! | Kimi K2-Thinking (OpenRouter) | `reasoning_details` | ✅ | ✅ | ❌ |
//! | MiniMax M2 (reasoning_split) | `reasoning_details` | ✅ | ✅ | ❌ |
//! | Gemini 2.5 (OpenRouter/Google 直连) | `reasoning_details` | ✅ | ✅ | ❌ |
//! | Gemini 3 (OpenRouter/Google 直连) | `reasoning_details` | ✅ | ✅ | ✅ (工具调用必需) |
//! | Gemini 2.5/3 (第三方 OpenAI 兼容) | 取决于第三方 | ⚠️ 走通用逻辑 | ⚠️ | ❌ |
//! | OpenAI o1/o3/o4 (OpenRouter) | `reasoning_details` | ✅ | ✅ | ❌ |
//! | GPT 5.x (OpenRouter) | `reasoning_details` | ✅ | ✅ | ❌ |
//! | GPT 5.x (原生 Responses API) | N/A | ❌ (自动保留) | N/A | ❌ |
//! | Claude 4.5 (extended thinking) | N/A | ❌ | ❌ | ❌ |
//! | Claude 3.x (extended thinking) | N/A | ❌ | ❌ | ❌ |
//! | 其他模型 | N/A | ❌ | ❌ | ❌ |

use serde::{Deserialize, Serialize};

use crate::llm_manager::adapters::{get_adapter, PassbackPolicy};
use crate::llm_manager::ApiConfig;

// ============================================================================
// 回传策略枚举
// ============================================================================

/// 思维链回传策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningPassbackPolicy {
    /// DeepSeek 风格：回传 `reasoning_content` 字符串
    /// 适用于：DeepSeek R1/Reasoner、Perplexity Sonar、xAI Grok、GLM-4-Thinking
    DeepSeekStyle,

    /// Reasoning Details 格式：回传 `reasoning_details` 数组
    /// 适用于：Gemini 3、OpenAI o1/o3/o4（via OpenRouter）
    ReasoningDetails,

    /// 不回传思维链
    /// 适用于：Claude、普通 GPT 等
    NoPassback,
}

impl Default for ReasoningPassbackPolicy {
    fn default() -> Self {
        Self::NoPassback
    }
}

// ============================================================================
// Reasoning Details 数据结构
// ============================================================================

/// 结构化思维链详情（用于 Gemini 3、OpenAI o1 等模型）
///
/// ## Gemini 3 thoughtSignature 支持
/// Gemini 3 在工具调用场景下要求回传 `thoughtSignature`，用于验证思维链的连续性。
/// 如果不回传签名，后续的工具调用轮次会报错。
///
/// 参考文档：https://ai.google.dev/gemini-api/docs/thinking#tool-use
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningDetail {
    /// 类型：`"thinking"` / `"summary"` / `"redacted"`
    #[serde(rename = "type")]
    pub detail_type: String,

    /// 思维内容文本
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    /// 摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// 加密内容（OpenAI Native）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_content: Option<String>,

    /// 块 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// 索引
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,

    /// 思维签名（Gemini 3 工具调用必需）
    ///
    /// Gemini 3 在响应中返回 `thoughtSignature`，在后续工具调用请求中必须回传此签名。
    /// 签名用于验证思维链的连续性和完整性。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ReasoningDetail {
    /// 创建简单的 thinking 类型详情
    pub fn thinking(text: String) -> Self {
        Self {
            detail_type: "thinking".to_string(),
            text: Some(text),
            summary: None,
            encrypted_content: None,
            id: None,
            index: None,
            signature: None,
        }
    }

    /// 创建带签名的 thinking 类型详情（Gemini 3 工具调用）
    pub fn thinking_with_signature(text: String, signature: String) -> Self {
        Self {
            detail_type: "thinking".to_string(),
            text: Some(text),
            summary: None,
            encrypted_content: None,
            id: None,
            index: None,
            signature: Some(signature),
        }
    }
}

// ============================================================================
// 策略判断函数
// ============================================================================

/// 获取完整的回传策略
///
/// ## 实现方式
/// 委托给适配器系统的 `get_passback_policy` 方法，并处理 OpenRouter 特殊规则。
///
/// ## OpenRouter 特殊规则
/// OpenRouter 作为中间层会标准化某些模型的输出格式为 `reasoning_details`：
/// - OpenAI o1/o3/o4
/// - GPT 5.x 系列
/// - Kimi K2-Thinking
/// - Gemini 2.5/3
///
/// 这些规则与模型本身无关，而是 OpenRouter 的转换行为。
pub fn get_passback_policy(config: &ApiConfig) -> ReasoningPassbackPolicy {
    let provider = config
        .provider_type
        .as_ref()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let model = config.model.to_lowercase();

    // OpenRouter 特殊规则（OpenRouter 会将某些模型的输出标准化为 reasoning_details）
    if provider == "openrouter" {
        // Gemini 2.5/3 via OpenRouter
        if model.contains("gemini-3") || model.contains("gemini-2.5") {
            return ReasoningPassbackPolicy::ReasoningDetails;
        }

        // OpenAI o1/o3/o4（原生 API 思维链加密不回传，但 OpenRouter 返回 reasoning_details）
        if model.contains("/o1")
            || model.contains("/o3")
            || model.contains("/o4")
            || model.contains("o1-")
            || model.contains("o3-")
            || model.contains("o4-")
        {
            return ReasoningPassbackPolicy::ReasoningDetails;
        }

        // GPT 5.x 系列（原生 Responses API 自动保留推理，但 OpenRouter 返回 reasoning_details）
        if model.contains("/gpt-5") || model.contains("gpt-5.") {
            return ReasoningPassbackPolicy::ReasoningDetails;
        }

        // Kimi K2-Thinking（Moonshot 官方 API 返回 reasoning_content，但 OpenRouter 返回 reasoning_details）
        if (model.contains("kimi") || model.contains("moonshot")) && model.contains("thinking") {
            return ReasoningPassbackPolicy::ReasoningDetails;
        }
    }

    // 委托给适配器系统
    let adapter = get_adapter(config.provider_type.as_deref(), &config.model_adapter);
    let adapter_policy = adapter.get_passback_policy(config);

    // 转换适配器的 PassbackPolicy 到本模块的 ReasoningPassbackPolicy
    match adapter_policy {
        PassbackPolicy::DeepSeekStyle => ReasoningPassbackPolicy::DeepSeekStyle,
        PassbackPolicy::ReasoningDetails => ReasoningPassbackPolicy::ReasoningDetails,
        PassbackPolicy::NoPassback => ReasoningPassbackPolicy::NoPassback,
    }
}

/// 简化判断：是否需要回传思维链
///
/// ## 用途
/// 快速判断是否需要在工具调用迭代中回传思维链内容。
pub fn requires_reasoning_passback(config: &ApiConfig) -> bool {
    !matches!(
        get_passback_policy(config),
        ReasoningPassbackPolicy::NoPassback
    )
}

/// 是否使用 reasoning_details 格式
///
/// ## 用途
/// 判断是否需要构建 `reasoning_details` 数组格式（而非 `reasoning_content` 字符串）。
pub fn uses_reasoning_details_format(config: &ApiConfig) -> bool {
    matches!(
        get_passback_policy(config),
        ReasoningPassbackPolicy::ReasoningDetails
    )
}

/// 新问题是否应清理历史思维链
///
/// ## 用途
/// 某些模型要求在新问题开始时清理之前的思维链历史，避免污染。
///
/// ## 返回
/// - `true`: 应该清理（大多数推理模型）
/// - `false`: 不需要清理（普通模型）
pub fn should_clear_reasoning_on_new_question(config: &ApiConfig) -> bool {
    requires_reasoning_passback(config)
}

/// 是否需要回传 thoughtSignature（Gemini 3 工具调用专用）
///
/// ## 用途
/// Gemini 3 在工具调用场景下要求回传 `thoughtSignature`。
/// 此函数用于判断是否需要缓存和回传签名。
///
/// ## 返回
/// - `true`: 需要回传签名（Gemini 3 系列）
/// - `false`: 不需要（其他模型）
pub fn requires_thought_signature(config: &ApiConfig) -> bool {
    let model = config.model.to_lowercase();
    // Gemini 3 系列需要回传 thoughtSignature
    model.contains("gemini-3") || model.contains("gemini3")
}

/// 是否是 Gemini 2.5 或更高版本（支持 thinking）
///
/// ## 用途
/// 判断是否是支持 thinking 配置的 Gemini 模型。
pub fn is_gemini_thinking_model(config: &ApiConfig) -> bool {
    let model = config.model.to_lowercase();
    model.contains("gemini-2.5") || model.contains("gemini-3") || model.contains("gemini3")
}

/// 获取策略的人类可读名称
pub fn get_policy_name(policy: ReasoningPassbackPolicy) -> &'static str {
    match policy {
        ReasoningPassbackPolicy::DeepSeekStyle => "DeepSeek Style (reasoning_content)",
        ReasoningPassbackPolicy::ReasoningDetails => "Reasoning Details (reasoning_details array)",
        ReasoningPassbackPolicy::NoPassback => "No Passback",
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(provider: Option<&str>, model: &str, is_reasoning: bool) -> ApiConfig {
        ApiConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            provider_type: provider.map(|s| s.to_string()),
            model: model.to_string(),
            is_reasoning,
            enabled: true,
            model_adapter: "openai".to_string(),
            max_output_tokens: 4096,
            supports_tools: true,
            supports_reasoning: is_reasoning,
            ..Default::default()
        }
    }

    #[test]
    fn test_deepseek_r1() {
        let config = make_config(Some("deepseek"), "deepseek-r1-0528", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
        assert!(requires_reasoning_passback(&config));
        assert!(!uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_deepseek_reasoner() {
        let config = make_config(Some("openai"), "deepseek-reasoner", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_deepseek_v3() {
        // DeepSeek V3.x with enable_thinking should use DeepSeekStyle
        let config = make_config(Some("siliconflow"), "deepseek-ai/deepseek-v3.2", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
        assert!(requires_reasoning_passback(&config));
    }

    #[test]
    fn test_deepseek_v3_no_reasoning() {
        // DeepSeek V3.x without reasoning should not passback
        let config = make_config(Some("siliconflow"), "deepseek-ai/deepseek-v3.2", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
    }

    #[test]
    fn test_openrouter_gemini() {
        let config = make_config(Some("openrouter"), "google/gemini-2.5-flash-preview", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
        assert!(requires_reasoning_passback(&config));
        assert!(uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_google_direct_gemini() {
        // Direct Google API should also use ReasoningDetails
        let config = make_config(Some("google"), "gemini-2.5-flash-preview", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
    }

    #[test]
    fn test_thirdparty_gemini_with_reasoning() {
        // Third-party OpenAI compatible Gemini API with is_reasoning=true
        // Falls through to generic is_reasoning logic (DeepSeekStyle)
        let config = make_config(Some("custom"), "gemini-2.5-flash", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_thirdparty_gemini_no_reasoning() {
        // Third-party OpenAI compatible Gemini API without reasoning
        // Should not passback (user needs to enable is_reasoning if needed)
        let config = make_config(Some("custom"), "gemini-2.5-flash", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
    }

    #[test]
    fn test_minimax_m2() {
        let config = make_config(Some("minimax"), "minimax/m2-reasoning", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
    }

    #[test]
    fn test_openrouter_o1() {
        let config = make_config(Some("openrouter"), "openai/o1-preview", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
    }

    #[test]
    fn test_sonar_reasoning() {
        let config = make_config(Some("perplexity"), "sonar-reasoning-pro", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_xai_grok() {
        let config = make_config(Some("xai"), "grok-3", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_claude() {
        let config = make_config(Some("anthropic"), "claude-3-opus", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
        assert!(!requires_reasoning_passback(&config));
    }

    #[test]
    fn test_generic_reasoning_model() {
        let config = make_config(Some("siliconflow"), "glm-4-thinking", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_generic_non_reasoning_model() {
        let config = make_config(Some("openai"), "gpt-4o", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
    }

    #[test]
    fn test_should_clear_reasoning() {
        let reasoning_config = make_config(Some("deepseek"), "deepseek-r1", true);
        let normal_config = make_config(Some("openai"), "gpt-4o", false);

        assert!(should_clear_reasoning_on_new_question(&reasoning_config));
        assert!(!should_clear_reasoning_on_new_question(&normal_config));
    }

    #[test]
    fn test_policy_name() {
        assert_eq!(
            get_policy_name(ReasoningPassbackPolicy::DeepSeekStyle),
            "DeepSeek Style (reasoning_content)"
        );
        assert_eq!(
            get_policy_name(ReasoningPassbackPolicy::ReasoningDetails),
            "Reasoning Details (reasoning_details array)"
        );
        assert_eq!(
            get_policy_name(ReasoningPassbackPolicy::NoPassback),
            "No Passback"
        );
    }

    // ========================================================================
    // 新增测试：OpenRouter 专用规则（Kimi K2 和 GPT 5.x）
    // ========================================================================

    #[test]
    fn test_openrouter_kimi_k2_thinking() {
        // OpenRouter 上的 Kimi K2-Thinking 应使用 ReasoningDetails
        let config = make_config(Some("openrouter"), "moonshotai/kimi-k2-thinking", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
        assert!(requires_reasoning_passback(&config));
        assert!(uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_openrouter_kimi_k2_instruct() {
        // OpenRouter 上的 Kimi K2-Instruct（非 thinking 模式）应走通用逻辑
        let config = make_config(Some("openrouter"), "moonshotai/kimi-k2", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
    }

    #[test]
    fn test_moonshot_kimi_k2_thinking() {
        // Moonshot 官方 API 的 Kimi K2-Thinking 应使用 DeepSeekStyle
        let config = make_config(Some("moonshot"), "kimi-k2-thinking", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
        assert!(requires_reasoning_passback(&config));
        assert!(!uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_thirdparty_kimi_k2_thinking() {
        // 第三方 API 的 Kimi K2-Thinking 应走通用 is_reasoning 逻辑（DeepSeekStyle）
        let config = make_config(Some("siliconflow"), "kimi-k2-thinking", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    // ========== K2.5 测试用例 ==========

    #[test]
    fn test_moonshot_kimi_k25() {
        // Moonshot 官方 API 的 K2.5 应使用 DeepSeekStyle（reasoning_content）
        let config = make_config(Some("moonshot"), "kimi-k2.5", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
        assert!(requires_reasoning_passback(&config));
        assert!(!uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_thirdparty_kimi_k25() {
        // 第三方 API（如 SiliconFlow）的 K2.5 应使用 DeepSeekStyle
        let config = make_config(Some("siliconflow"), "kimi-k2.5", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_thirdparty_kimi_k2_5_alt_format() {
        // 替代命名格式 kimi-k2-5 也应支持
        let config = make_config(Some("siliconflow"), "kimi-k2-5", true);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_openrouter_kimi_k25() {
        // OpenRouter 上的 K2.5（如果未来支持）应走 OpenRouter 规则
        // 目前 OpenRouter 只针对 thinking 模型返回 reasoning_details
        // K2.5 虽然默认启用 thinking，但名称中不含 "thinking"，走通用逻辑
        let config = make_config(Some("openrouter"), "moonshotai/kimi-k2.5", true);
        // 由于没有 "thinking" 关键字，不走 OpenRouter 的 thinking 特殊规则
        // 但 is_reasoning=true 会触发适配器的通用逻辑
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::DeepSeekStyle
        );
    }

    #[test]
    fn test_openrouter_gpt5() {
        // OpenRouter 上的 GPT 5.x 应使用 ReasoningDetails
        let config = make_config(Some("openrouter"), "openai/gpt-5.2", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
        assert!(requires_reasoning_passback(&config));
        assert!(uses_reasoning_details_format(&config));
    }

    #[test]
    fn test_openrouter_gpt5_pro() {
        // OpenRouter 上的 GPT 5.2 Pro 应使用 ReasoningDetails
        let config = make_config(Some("openrouter"), "openai/gpt-5.2-pro", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
    }

    #[test]
    fn test_openrouter_gpt5_instant() {
        // OpenRouter 上的 GPT 5.2 Instant 应使用 ReasoningDetails
        let config = make_config(Some("openrouter"), "openai/gpt-5.2-chat-latest", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::ReasoningDetails
        );
    }

    #[test]
    fn test_openai_native_gpt5() {
        // OpenAI 原生 API 的 GPT 5.x 应不回传（使用 Responses API 自动保留）
        let config = make_config(Some("openai"), "gpt-5.2", false);
        assert_eq!(
            get_passback_policy(&config),
            ReasoningPassbackPolicy::NoPassback
        );
    }
}
