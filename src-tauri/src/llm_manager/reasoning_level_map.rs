//! 思考强度档位映射（2026-10-03，方案 F）。
//!
//! ## 职责
//! 把前端统一发送的五档（low/medium/high/xhigh/max）映射为该模型在其当前
//! 协议下**实际可接受**的档位，避免"前端可选但后端 400"或"被适配器静默
//! 折叠成别的档"。
//!
//! ## 数据来源
//! `scripts/reasoning-level-registry.json`：每个模型家族声明的档位全集、
//! 官方默认档、可否关闭，以及协议维度的档位上限（protocol_caps）。
//!
//! ## 分流规则（按产品裁定）
//! - **官方渠道**：按能力表**就近吸附**。例如官方 gpt-6 在
//!   Chat Completions 下选 max → 吸附为 xhigh（官方仅 Responses 接受 max，
//!   Chat 路径发 max 会返回 400）。
//! - **自定义/中转渠道**：五档**原样透传**不做裁剪——中转站已完成上游映射，
//!   在此再裁剪反而会丢掉用户意图。
//! - **协议上限**：protocol_caps 对官方渠道生效（如 gpt-6 的 Chat Completions
//!   上限为 xhigh）。
//!
//! ## C1 约束（本模块不得违反）
//! 只允许改写 `reasoning_effort` / `thinking_budget` 两个字段。
//! 不得触碰 `enable_thinking`、采样参数、verbosity、extra_body 等；
//! 也不得改变适配器的 early_return 语义（early_return 由适配器自身决定，
//! 本模块仅在适配器执行前预置 config）。

use serde::Deserialize;
use std::sync::LazyLock;

use super::ApiConfig;

#[derive(Debug, Clone, Deserialize)]
struct RegistryDocument {
    profiles: Vec<LevelProfile>,
}

#[derive(Debug, Clone, Deserialize)]
struct LevelProfile {
    id: String,
    family: String,
    model_contains: Vec<String>,
    /// 该模型家族官方文档列明的档位全集（含 none 时表示可显式关闭）。
    levels: Vec<String>,
    /// 官方明示的档位别名：请求值 → 实际发送值。
    ///
    /// 优先于"就近吸附"使用——官方映射表有时无法用距离表达，例如
    /// DeepSeek 官方把 `medium` 与 `xhigh` **都**映射为 `high`，
    /// 而"就近吸附"会把 xhigh 吸到 max（距离更近但违反官方语义）。
    #[serde(default)]
    level_aliases: std::collections::HashMap<String, String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    can_disable: bool,
    /// 协议维度上限：协议名 → { max_level }。
    #[serde(default)]
    protocol_caps: std::collections::HashMap<String, ProtocolCap>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProtocolCap {
    max_level: String,
}

static LEVEL_REGISTRY: LazyLock<Vec<LevelProfile>> = LazyLock::new(|| {
    let raw = include_str!("../../../scripts/reasoning-level-registry.json");
    serde_json::from_str::<RegistryDocument>(raw)
        .map(|doc| doc.profiles)
        .unwrap_or_else(|err| {
            eprintln!("[reasoning-level-registry] 解析失败，按空表处理（所有档位透传）: {err}");
            Vec::new()
        })
});

/// 档位深度序（就近吸附与比较用）。
fn level_rank(level: &str) -> Option<u8> {
    match level.trim().to_ascii_lowercase().as_str() {
        "none" => Some(0),
        "minimal" => Some(1),
        "low" => Some(2),
        "medium" => Some(3),
        "high" => Some(4),
        "xhigh" => Some(5),
        "max" => Some(6),
        _ => None,
    }
}

/// 按包含匹配找到最贴合的档位 profile。
///
/// 选择规则：所有 model_contains 片段都命中的 profile 中，取片段总长度最大者
///（更具体的条目优先，如 `gpt-6-astra` 胜过 `gpt-6`）。
fn find_profile(config: &ApiConfig) -> Option<&'static LevelProfile> {
    let model = config.model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return None;
    }
    LEVEL_REGISTRY
        .iter()
        .filter(|profile| {
            profile
                .model_contains
                .iter()
                .all(|fragment| model.contains(&fragment.to_ascii_lowercase()))
        })
        .max_by_key(|profile| {
            profile
                .model_contains
                .iter()
                .map(|fragment| fragment.len())
                .sum::<usize>()
        })
}

/// 当前协议名（用于取 protocol_caps）。
fn effective_protocol(config: &ApiConfig) -> String {
    super::effective_api_protocol_for_config(config)
}

/// 该配置是否为官方渠道。
///
/// 依据 provider-protocol-registry.json 的 `official` 字段（DeepSeek 额外要求
/// host 精确匹配 api.deepseek.com，因为同一 provider_type 可能被用户改成中转地址）。
fn is_official_channel(config: &ApiConfig) -> bool {
    let provider = config
        .provider_type
        .as_deref()
        .or(config.provider_scope.as_deref())
        .unwrap_or_default();
    if provider.eq_ignore_ascii_case("deepseek") {
        return super::is_official_deepseek_config(config);
    }
    super::provider_is_official(provider)
}

/// 把请求档位吸附到给定集合中最近的合法档（平局取更高档）。
fn snap_to_levels(requested: &str, allowed: &[String], ceiling: Option<&str>) -> Option<String> {
    let requested_rank = level_rank(requested)?;
    let ceiling_rank = ceiling.and_then(level_rank);

    let mut best: Option<(u8, String)> = None;
    for candidate in allowed {
        let Some(rank) = level_rank(candidate) else {
            continue;
        };
        // 协议上限：高于上限的档位不参与吸附目标。
        if let Some(limit) = ceiling_rank {
            if rank > limit {
                continue;
            }
        }
        let distance = rank.abs_diff(requested_rank);
        let is_better = match &best {
            None => true,
            Some((best_distance, best_level)) => {
                // 距离更近优先；平局取更高档（与前端吸附方向一致）。
                distance < *best_distance
                    || (distance == *best_distance
                        && level_rank(best_level).is_some_and(|r| rank > r))
            }
        };
        if is_better {
            best = Some((distance, candidate.clone()));
        }
    }
    best.map(|(_, level)| level)
}

/// 依据能力表映射档位；返回 None 表示无需改写（保持用户原值）。
///
/// 返回 Some(new_config) 时，只有 reasoning_effort / thinking_budget 可能变化。
pub(crate) fn map_reasoning_level_for_config(config: &ApiConfig) -> Option<ApiConfig> {
    let requested = config
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let requested_lower = requested.to_ascii_lowercase();

    // 关闭语义（none/unset）不由本模块处理：各适配器已有既定的关闭路径，
    // 且改写它会与 enable_thinking 的语义纠缠（C1）。
    if matches!(requested_lower.as_str(), "none" | "unset") {
        return None;
    }
    // 非标准档位（供应商原生词如 auto/adaptive/enabled）交由适配器自身归一。
    if level_rank(&requested_lower).is_none() {
        return None;
    }

    // 自定义/中转渠道：五档原样透传，不做任何裁剪（中转站自行完成上游映射）。
    if !is_official_channel(config) {
        return None;
    }

    let Some(profile) = find_profile(config) else {
        // 官方渠道但能力表未覆盖该模型：保守起见不改写（透传），
        // 由适配器既有归一逻辑兜底。
        return None;
    };

    // 官方声明的档位全集（去掉 none —— 关闭语义不在本模块处理）。
    let allowed: Vec<String> = profile
        .levels
        .iter()
        .filter(|level| !level.eq_ignore_ascii_case("none"))
        .cloned()
        .collect();
    if allowed.is_empty() {
        return None;
    }

    let protocol = effective_protocol(config);
    let ceiling = profile
        .protocol_caps
        .get(&protocol)
        .map(|cap| cap.max_level.as_str());

    // 1) 官方明示别名优先：官方映射表常无法用"距离"表达
    //（如 DeepSeek 把 medium 与 xhigh 都映射为 high，而就近吸附会把
    // xhigh 吸到 max）。别名为官方语义的精确表达。
    if let Some(aliased) = profile.level_aliases.get(&requested_lower) {
        let alias_ok = allowed
            .iter()
            .any(|level| level.eq_ignore_ascii_case(aliased))
            && match (ceiling.and_then(level_rank), level_rank(aliased)) {
                (Some(limit), Some(rank)) => rank <= limit,
                _ => true,
            };
        if alias_ok && !aliased.eq_ignore_ascii_case(&requested_lower) {
            log::debug!(
                "[reasoning-level] 档位按官方别名映射: model={}, family={}, protocol={}, {} -> {}",
                config.model,
                profile.family,
                protocol,
                requested_lower,
                aliased
            );
            let mut mapped = config.clone();
            mapped.reasoning_effort = Some(aliased.clone());
            return Some(mapped);
        }
    }

    // 2) 档位已在允许集合内且未超协议上限 → 无需改写。
    let within_allowed = allowed
        .iter()
        .any(|level| level.eq_ignore_ascii_case(&requested_lower));
    let within_ceiling = match (ceiling.and_then(level_rank), level_rank(&requested_lower)) {
        (Some(limit), Some(rank)) => rank <= limit,
        _ => true,
    };
    if within_allowed && within_ceiling {
        return None;
    }

    // 3) 兜底：就近吸附。
    let snapped = snap_to_levels(&requested_lower, &allowed, ceiling)?;
    if snapped.eq_ignore_ascii_case(&requested_lower) {
        return None;
    }

    log::debug!(
        "[reasoning-level] 档位按模型能力映射: model={}, family={}, protocol={}, {} -> {}",
        config.model,
        profile.family,
        protocol,
        requested_lower,
        snapped
    );

    let mut mapped = config.clone();
    mapped.reasoning_effort = Some(snapped);
    // C1：只改 effort。thinking_budget 保持用户原值——适配器会在
    // "已配置 effort" 时按既有互斥规则自行处理 budget。
    Some(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(model: &str, effort: &str) -> ApiConfig {
        ApiConfig {
            model: model.to_string(),
            model_adapter: "general".to_string(),
            provider_type: Some("openai".to_string()),
            base_url: "https://api.openai.com/v1".to_string(),
            reasoning_effort: Some(effort.to_string()),
            is_reasoning: true,
            supports_reasoning: true,
            ..Default::default()
        }
    }

    #[test]
    fn gpt6_max_snaps_to_xhigh_on_chat_completions() {
        // 官方文档：max 仅 Responses 接受，Chat Completions 发 max 会 400。
        // 必须显式指定 Chat Completions：openai 官方默认协议是 Responses
        //（见 provider-protocol-registry 的 default_protocol）。
        let mut cfg = config("gpt-6-sol", "max");
        cfg.api_protocol = Some("openai_chat_completions".to_string());
        let mapped = map_reasoning_level_for_config(&cfg)
            .expect("official gpt-6 on chat completions must map max");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn gpt6_max_passes_through_on_default_responses_route() {
        // openai 官方默认走 Responses，此时 max 是合法档，必须透传。
        let cfg = config("gpt-6-sol", "max");
        assert!(
            map_reasoning_level_for_config(&cfg).is_none(),
            "默认 Responses 路径应透传 max（不吸附）"
        );
    }

    #[test]
    fn custom_relay_keeps_all_five_levels() {
        // 中转渠道不做裁剪：中转站自行完成上游映射。
        for level in ["low", "medium", "high", "xhigh", "max"] {
            let mut cfg = config("some-relay-gpt-6-sol", level);
            cfg.provider_type = Some("custom".to_string());
            cfg.base_url = "https://relay.example.com/v1".to_string();
            assert!(
                map_reasoning_level_for_config(&cfg).is_none(),
                "自定义渠道必须原样透传 {level}"
            );
        }
    }

    #[test]
    fn gpt55_max_snaps_to_xhigh() {
        // gpt-5.5 官方档位不含 max。
        let mapped = map_reasoning_level_for_config(&config("gpt-5.5", "max"))
            .expect("gpt-5.5 max must snap");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn gpt51_xhigh_snaps_to_high() {
        // gpt-5.1 官方档位为 low/medium/high（无 xhigh）。
        let mapped = map_reasoning_level_for_config(&config("gpt-5.1", "xhigh"))
            .expect("gpt-5.1 xhigh must snap");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn gemini3_pro_medium_stays_and_xhigh_snaps() {
        let mut cfg = config("gemini-3.1-pro-preview", "low");
        cfg.provider_type = Some("google".to_string());
        cfg.model_adapter = "google".to_string();
        cfg.base_url = "https://generativelanguage.googleapis.com".to_string();
        // low 在 3.x Pro 的档位集合内，不应改写。
        assert!(map_reasoning_level_for_config(&cfg).is_none());

        cfg.reasoning_effort = Some("xhigh".to_string());
        let mapped = map_reasoning_level_for_config(&cfg).expect("xhigh 需吸附");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn glm53_medium_snaps_to_high() {
        let mut cfg = config("glm-5.3", "medium");
        cfg.provider_type = Some("zhipu".to_string());
        cfg.model_adapter = "zhipu".to_string();
        cfg.base_url = "https://open.bigmodel.cn/api/paas/v4".to_string();
        let mapped = map_reasoning_level_for_config(&cfg).expect("GLM-5.3 无 medium 档");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn kimi_k3_medium_snaps_to_high() {
        let mut cfg = config("kimi-k3", "medium");
        cfg.provider_type = Some("moonshot".to_string());
        cfg.model_adapter = "moonshot".to_string();
        cfg.base_url = "https://api.moonshot.cn/v1".to_string();
        let mapped = map_reasoning_level_for_config(&cfg).expect("K3 档位为 low/high/max");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn non_standard_vendor_words_are_left_to_adapters() {
        // auto/adaptive 等供应商原生词不在五档内，本模块不得干预。
        for word in ["auto", "adaptive", "enabled", "ultra"] {
            let cfg = config("gpt-6-sol", word);
            assert!(
                map_reasoning_level_for_config(&cfg).is_none(),
                "{word} 应留给适配器归一"
            );
        }
    }

    #[test]
    fn none_and_unset_are_not_touched() {
        // 关闭语义由各适配器的既定路径处理，本模块不介入。
        for word in ["none", "unset"] {
            let cfg = config("gpt-6-sol", word);
            assert!(
                map_reasoning_level_for_config(&cfg).is_none(),
                "{word} 不应被映射"
            );
        }
    }

    #[test]
    fn mapping_only_touches_effort_field() {
        // C1：映射结果与原始配置的差异必须只在 reasoning_effort 一个字段上。
        // 用显式 Chat Completions 触发映射（Responses 下 max 合法、不会映射）。
        let mut original = config("gpt-6-sol", "max");
        original.api_protocol = Some("openai_chat_completions".to_string());
        let mapped = map_reasoning_level_for_config(&original).expect("应发生映射");

        assert_eq!(mapped.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(mapped.thinking_budget, original.thinking_budget);
        assert_eq!(mapped.enable_thinking, original.enable_thinking);
        assert_eq!(mapped.thinking_enabled, original.thinking_enabled);
        assert_eq!(mapped.is_reasoning, original.is_reasoning);
        assert_eq!(mapped.supports_reasoning, original.supports_reasoning);
        assert_eq!(mapped.verbosity, original.verbosity);
        assert_eq!(mapped.extra_body, original.extra_body);
        assert_eq!(mapped.temperature, original.temperature);
        assert_eq!(mapped.api_protocol, original.api_protocol);
    }

    #[test]
    fn deepseek_xhigh_uses_official_alias_not_nearest_snap() {
        // 官方映射表：DeepSeek 的 medium 与 xhigh 都映射为 high。
        // 若走"就近吸附"，xhigh 会吸到 max（距离更近但违反官方语义）。
        let mut cfg = config("deepseek-v4-pro", "xhigh");
        cfg.provider_type = Some("deepseek".to_string());
        cfg.model_adapter = "deepseek".to_string();
        cfg.base_url = "https://api.deepseek.com/v1".to_string();
        let mapped = map_reasoning_level_for_config(&cfg).expect("xhigh 需按官方别名映射");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn deepseek_medium_maps_to_high_per_official_table() {
        let mut cfg = config("deepseek-v4-pro", "medium");
        cfg.provider_type = Some("deepseek".to_string());
        cfg.model_adapter = "deepseek".to_string();
        cfg.base_url = "https://api.deepseek.com/v1".to_string();
        let mapped = map_reasoning_level_for_config(&cfg).expect("medium 需按官方别名映射");
        assert_eq!(mapped.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn deepseek_low_and_max_pass_through() {
        for level in ["low", "max"] {
            let mut cfg = config("deepseek-v4-pro", level);
            cfg.provider_type = Some("deepseek".to_string());
            cfg.model_adapter = "deepseek".to_string();
            cfg.base_url = "https://api.deepseek.com/v1".to_string();
            assert!(
                map_reasoning_level_for_config(&cfg).is_none(),
                "DeepSeek 原生档 {level} 应透传"
            );
        }
    }

    #[test]
    fn unknown_model_on_official_host_is_left_untouched() {
        let cfg = config("totally-unknown-model", "max");
        assert!(
            map_reasoning_level_for_config(&cfg).is_none(),
            "能力表未覆盖的模型应透传，由适配器兜底"
        );
    }
}
