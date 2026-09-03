//! Centralized provider/model dialect decisions for the model2 pipeline.
//!
//! Phase 1 deliberately preserves the legacy heuristics. Later phases can replace
//! those heuristics with registry capabilities without touching request assembly.

use crate::reasoning_policy::{
    get_passback_policy, should_passback_plain_assistant_reasoning, ReasoningPassbackPolicy,
};
use serde::Serialize;

use super::{is_official_deepseek_config, should_use_openai_responses_for_config, ApiConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct RuntimeReasoningOverride {
    /// Runtime `enable_thinking=false` must be ignored for these OpenAI models.
    pub force_enabled: bool,
    /// Effort sent when runtime reasoning is disabled (`none` for modern GPT-5).
    pub disabled_effort: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct ProviderQuirks {
    /// B1: generation token-limit field.
    pub max_tokens_field: MaxTokensField,
    /// B1 legacy behavior: generic reasoning adapters may pre-populate max_tokens.
    pub preserve_existing_max_tokens: bool,
    /// B2: legacy OCR/Anki token-limit field (MiMo is the sole exception).
    pub legacy_max_tokens_field: MaxTokensField,
    /// B3: whether temperature/top-p/penalties are legal in reasoning mode.
    pub sampling_params_allowed: bool,
    /// B12/S1: Qwen rejects tool_choice on tool-result follow-ups.
    pub strip_tool_choice_on_tool_result: bool,
    /// S5/B11: static half of the DeepSeek Responses web-search gate.
    pub server_side_web_search: bool,
    /// B13: legacy raw-prompt/Anki JSON-mode behavior.
    pub force_json_response_format: bool,
    /// B4/B9: provider-specific reasoning history representation.
    pub reasoning_passback: ReasoningPassbackPolicy,
    /// B9: whether plain assistant history should retain reasoning.
    pub passback_plain_assistant_reasoning: bool,
    /// S7: runtime reasoning-disable policy.
    pub runtime_reasoning: RuntimeReasoningOverride,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct EndpointQuirks {
    /// S4/B5: connectivity-test payload uses the MiMo chat-completions dialect.
    pub use_mimo_test_payload: bool,
}

/// Model fragments that made the legacy S7 branch force reasoning on.
///
/// `gpt-5` initial releases and o-family matching need boundary-aware checks, so
/// they live in adjacent tables below instead of this substring table.
pub(crate) const FORCED_REASONING_MODEL_PATTERNS: [&str; 3] = ["codex", "gpt-oss", "-pro"];
const OPENAI_O_FAMILIES: [&str; 3] = ["o1", "o3", "o4"];
const MODERN_GPT5_NONE_PREFIXES: [&str; 6] = [
    "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5", "gpt-5.6",
];
const INITIAL_GPT5_VARIANTS: [&str; 2] = ["gpt-5-mini", "gpt-5-nano"];

fn provider_field_matches(value: Option<&str>, expected: &str) -> bool {
    value.is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

fn model_matches_family(model: &str, family: &str) -> bool {
    model == family
        || model.starts_with(&format!("{family}-"))
        || model.ends_with(&format!("/{family}"))
        || model.contains(&format!("/{family}-"))
}

fn runtime_reasoning_override(config: &ApiConfig) -> RuntimeReasoningOverride {
    let provider_type = config.provider_type.as_deref().unwrap_or_default();
    let provider_scope = config.provider_scope.as_deref().unwrap_or_default();
    let protocol = config.api_protocol.as_deref().unwrap_or_default();
    let model = config.model.to_lowercase();

    let has_explicit_openai_protocol =
        matches!(protocol, "openai_chat_completions" | "openai_responses");
    let is_codex = provider_type.eq_ignore_ascii_case("openai_codex")
        || provider_scope.eq_ignore_ascii_case("openai_codex");
    let is_openai_o_family = OPENAI_O_FAMILIES
        .iter()
        .any(|family| model_matches_family(&model, family));
    let is_openai_reasoning_model = (model.contains("gpt-5") && !model.contains("gpt-5-chat"))
        || model.contains("codex")
        || model.contains("gpt-oss")
        || is_openai_o_family;

    // Preserve legacy profiles that did not persist api_protocol.
    let is_openai_protocol = has_explicit_openai_protocol
        || (protocol.is_empty() && (is_codex || is_openai_reasoning_model));
    let modern_gpt5_supports_none = MODERN_GPT5_NONE_PREFIXES
        .iter()
        .any(|prefix| model.contains(prefix))
        && !model.contains("-pro")
        && !model.contains("codex")
        && !model.contains("-chat");
    let initial_gpt5 = (model == "gpt-5"
        || model.ends_with("/gpt-5")
        || INITIAL_GPT5_VARIANTS
            .iter()
            .any(|variant| model.contains(variant)))
        && !model.contains("gpt-5.");
    let forced_by_pattern = FORCED_REASONING_MODEL_PATTERNS
        .iter()
        .any(|pattern| model.contains(pattern));
    let forced_openai_reasoning = (is_codex || is_openai_reasoning_model)
        && (is_codex || forced_by_pattern || initial_gpt5 || is_openai_o_family);

    RuntimeReasoningOverride {
        force_enabled: is_openai_protocol && forced_openai_reasoning,
        disabled_effort: (is_openai_protocol && modern_gpt5_supports_none).then_some("none"),
    }
}

/// Resolve all phase-1 quirks once from a complete API configuration.
pub(crate) fn resolve_quirks(config: &ApiConfig) -> ProviderQuirks {
    let model = config.model.to_lowercase();
    let model_slug = model.rsplit('/').next().unwrap_or(&model);
    let is_qwen = provider_field_matches(config.provider_type.as_deref(), "qwen")
        || config.model_adapter.eq_ignore_ascii_case("qwen");
    let is_mimo = provider_field_matches(config.provider_scope.as_deref(), "mimo")
        || provider_field_matches(config.provider_type.as_deref(), "mimo")
        || config.model_adapter.eq_ignore_ascii_case("mimo")
        || config.base_url.to_lowercase().contains("xiaomimimo.com")
        || model.starts_with("mimo-v");
    let is_mistral = provider_field_matches(config.provider_scope.as_deref(), "mistral")
        || provider_field_matches(config.provider_type.as_deref(), "mistral")
        || config.model_adapter.eq_ignore_ascii_case("mistral")
        || config.base_url.to_lowercase().contains("mistral.ai")
        || model_slug.starts_with("mistral-")
        || model_slug.starts_with("magistral-");

    let max_tokens_field = if is_mimo {
        MaxTokensField::MaxCompletionTokens
    } else if is_mistral {
        MaxTokensField::MaxTokens
    } else if config.is_reasoning {
        MaxTokensField::MaxCompletionTokens
    } else {
        MaxTokensField::MaxTokens
    };
    let reasoning_passback = get_passback_policy(config);

    ProviderQuirks {
        max_tokens_field,
        preserve_existing_max_tokens: config.is_reasoning && !is_mimo && !is_mistral,
        legacy_max_tokens_field: if is_mimo {
            MaxTokensField::MaxCompletionTokens
        } else {
            MaxTokensField::MaxTokens
        },
        sampling_params_allowed: !config.is_reasoning || is_mimo,
        strip_tool_choice_on_tool_result: is_qwen,
        server_side_web_search: config.supports_tools
            && should_use_openai_responses_for_config(config)
            && is_official_deepseek_config(config),
        // Preserve B13's case-sensitive prefix behavior exactly.
        force_json_response_format: config.model.starts_with("gpt-"),
        reasoning_passback,
        passback_plain_assistant_reasoning: should_passback_plain_assistant_reasoning(config),
        runtime_reasoning: runtime_reasoning_override(config),
    }
}

/// Resolve the reduced quirk set available to connectivity tests, where no
/// persisted `ApiConfig` exists yet.
pub(crate) fn resolve_endpoint_quirks(model: &str, base_url: &str) -> EndpointQuirks {
    EndpointQuirks {
        use_mimo_test_payload: model.to_lowercase().starts_with("mimo-v")
            || base_url.to_lowercase().contains("xiaomimimo.com"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(provider: &str, adapter: &str, model: &str) -> ApiConfig {
        ApiConfig {
            provider_type: Some(provider.to_string()),
            provider_scope: Some(provider.to_string()),
            model_adapter: adapter.to_string(),
            model: model.to_string(),
            base_url: format!("https://{provider}.example.com/v1"),
            ..Default::default()
        }
    }

    #[test]
    fn provider_decision_matrix_preserves_phase1_behavior() {
        struct Case {
            name: &'static str,
            config: ApiConfig,
            generation: MaxTokensField,
            legacy: MaxTokensField,
            sampling: bool,
            strip_tool_choice: bool,
            server_web_search: bool,
        }

        let mut mimo = config("mimo", "mimo", "mimo-v2.5-pro");
        mimo.is_reasoning = true;

        let mut mistral = config("mistral", "mistral", "magistral-medium-2507");
        mistral.is_reasoning = true;

        let mut qwen = config("qwen", "qwen", "qwen3-max");
        qwen.is_reasoning = true;

        let mut deepseek_official = config("deepseek", "deepseek", "deepseek-v4-flash");
        deepseek_official.base_url = "https://api.deepseek.com/v1".to_string();
        deepseek_official.supports_tools = true;
        deepseek_official.is_reasoning = true;

        let mut deepseek_third_party =
            config("siliconflow", "deepseek", "deepseek-ai/deepseek-v4-flash");
        deepseek_third_party.supports_tools = true;
        deepseek_third_party.is_reasoning = true;

        let cases = [
            Case {
                name: "mimo reasoning",
                config: mimo,
                generation: MaxTokensField::MaxCompletionTokens,
                legacy: MaxTokensField::MaxCompletionTokens,
                sampling: true,
                strip_tool_choice: false,
                server_web_search: false,
            },
            Case {
                name: "mistral reasoning",
                config: mistral,
                generation: MaxTokensField::MaxTokens,
                legacy: MaxTokensField::MaxTokens,
                sampling: false,
                strip_tool_choice: false,
                server_web_search: false,
            },
            Case {
                name: "qwen reasoning",
                config: qwen,
                generation: MaxTokensField::MaxCompletionTokens,
                legacy: MaxTokensField::MaxTokens,
                sampling: false,
                strip_tool_choice: true,
                server_web_search: false,
            },
            Case {
                name: "official deepseek responses",
                config: deepseek_official,
                generation: MaxTokensField::MaxCompletionTokens,
                legacy: MaxTokensField::MaxTokens,
                sampling: false,
                strip_tool_choice: false,
                server_web_search: true,
            },
            Case {
                name: "third-party deepseek chat",
                config: deepseek_third_party,
                generation: MaxTokensField::MaxCompletionTokens,
                legacy: MaxTokensField::MaxTokens,
                sampling: false,
                strip_tool_choice: false,
                server_web_search: false,
            },
        ];

        for case in cases {
            let actual = resolve_quirks(&case.config);
            assert_eq!(actual.max_tokens_field, case.generation, "{}", case.name);
            assert_eq!(actual.legacy_max_tokens_field, case.legacy, "{}", case.name);
            assert_eq!(
                actual.sampling_params_allowed, case.sampling,
                "{}",
                case.name
            );
            assert_eq!(
                actual.strip_tool_choice_on_tool_result, case.strip_tool_choice,
                "{}",
                case.name
            );
            assert_eq!(
                actual.server_side_web_search, case.server_web_search,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn runtime_reasoning_patterns_preserve_forced_and_disableable_models() {
        for model in [
            "gpt-5",
            "openai/gpt-5-mini",
            "gpt-5-pro",
            "gpt-oss-120b",
            "o3",
        ] {
            let mut config = config("custom", "general", model);
            config.api_protocol = Some("openai_responses".to_string());
            assert!(
                resolve_quirks(&config).runtime_reasoning.force_enabled,
                "model={model}"
            );
        }

        let mut modern = config("custom", "general", "gpt-5.5");
        modern.api_protocol = Some("openai_responses".to_string());
        assert_eq!(
            resolve_quirks(&modern).runtime_reasoning,
            RuntimeReasoningOverride {
                force_enabled: false,
                disabled_effort: Some("none"),
            }
        );
    }

    #[test]
    fn endpoint_matrix_keeps_mimo_test_payload_detection() {
        assert!(
            resolve_endpoint_quirks("other-model", "https://api.xiaomimimo.com/v1")
                .use_mimo_test_payload
        );
        assert!(
            resolve_endpoint_quirks("MiMo-V2.5", "https://proxy.example/v1").use_mimo_test_payload
        );
        assert!(
            !resolve_endpoint_quirks("mistral-small", "https://api.mistral.ai/v1")
                .use_mimo_test_payload
        );
    }

    #[test]
    fn provider_quirks_phase1_snapshot() {
        let protocols = [
            (
                "openai_chat_completions/official",
                "mistral",
                "mistral",
                "https://api.mistral.ai/v1",
                "mistral-small-latest",
                "openai_chat_completions",
            ),
            (
                "openai_chat_completions/third_party",
                "qwen",
                "qwen",
                "https://proxy.example.com/v1",
                "qwen3-max",
                "openai_chat_completions",
            ),
            (
                "openai_responses/official",
                "openai",
                "general",
                "https://api.openai.com/v1",
                "gpt-5.5",
                "openai_responses",
            ),
            (
                "openai_responses/third_party",
                "custom",
                "general",
                "https://responses.example.com/v1",
                "openai/gpt-5.5",
                "openai_responses",
            ),
            (
                "anthropic_messages/official",
                "anthropic",
                "anthropic",
                "https://api.anthropic.com/v1",
                "claude-sonnet-4-5",
                "anthropic_messages",
            ),
            (
                "anthropic_messages/third_party",
                "custom",
                "anthropic",
                "https://anthropic-proxy.example.com/v1",
                "claude-sonnet-4-5",
                "anthropic_messages",
            ),
            (
                "google_generate_content/official",
                "google",
                "gemini",
                "https://generativelanguage.googleapis.com",
                "gemini-3-flash",
                "google_generate_content",
            ),
            (
                "google_generate_content/third_party",
                "custom",
                "gemini",
                "https://gemini-proxy.example.com",
                "gemini-3-flash",
                "google_generate_content",
            ),
        ];

        let mut snapshot = Vec::new();
        for (name, provider, adapter, base_url, model, protocol) in protocols {
            for reasoning in [false, true] {
                let config = ApiConfig {
                    provider_type: Some(provider.to_string()),
                    provider_scope: Some(provider.to_string()),
                    model_adapter: adapter.to_string(),
                    base_url: base_url.to_string(),
                    model: model.to_string(),
                    api_protocol: Some(protocol.to_string()),
                    supports_openai_responses: (protocol == "openai_responses").then_some(true),
                    is_reasoning: reasoning,
                    supports_reasoning: reasoning,
                    supports_tools: true,
                    ..Default::default()
                };
                snapshot.push(json!({
                    "case": format!("{name}/reasoning={reasoning}"),
                    "quirks": resolve_quirks(&config),
                }));
            }
        }

        let actual = serde_json::to_string_pretty(&snapshot).unwrap();
        assert_eq!(
            actual,
            include_str!("snapshots/provider_quirks_phase1.json").trim_end()
        );
    }
}
