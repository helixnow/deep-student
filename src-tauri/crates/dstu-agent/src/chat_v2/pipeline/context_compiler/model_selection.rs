//! Generation-model resolution for the context compiler.
//!
//! Classifies configs into text / multimodal / dedicated-OCR kinds, resolves the
//! requested and strict (persona) models, and applies per-send parameter overrides.

use crate::chat_v2::types::{CanonicalContentPart, SendOptions};
use crate::llm_manager::ApiConfig;
use crate::vfs::retrieval_planner::ActiveGenerationModel;
use std::collections::HashSet;

pub(super) fn auxiliary_mm_eligible(
    config: &ApiConfig,
    active_config_id: &str,
    dedicated_ocr_ids: &HashSet<String>,
) -> bool {
    generation_model_kind(config, dedicated_ocr_ids) == Some(ActiveGenerationModel::Multimodal)
        && config.id != active_config_id
}

pub(super) fn is_dedicated_ocr_candidate(
    candidate: &crate::llm_manager::OcrRuntimeCandidate,
) -> bool {
    candidate.engine_type().is_dedicated_ocr()
}

pub(super) fn generation_model_kind(
    config: &ApiConfig,
    dedicated_ocr_ids: &HashSet<String>,
) -> Option<ActiveGenerationModel> {
    if !config.enabled
        || config.is_embedding
        || config.is_reranker
        || config.is_image_generation
        || dedicated_ocr_ids.contains(&config.id)
        || crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model)
            .is_dedicated_ocr()
    {
        return None;
    }
    Some(if config.is_multimodal {
        ActiveGenerationModel::Multimodal
    } else {
        ActiveGenerationModel::Text
    })
}

pub(super) fn requested_generation_model(
    requested_model_id: Option<&str>,
    selected: Option<&ApiConfig>,
    configs: &[ApiConfig],
) -> Option<ActiveGenerationModel> {
    requested_model_id
        .and_then(|id| {
            configs
                .iter()
                .find(|config| config.id == id || config.model == id)
        })
        .or(selected)
        .map(|config| {
            if config.is_multimodal {
                ActiveGenerationModel::Multimodal
            } else {
                ActiveGenerationModel::Text
            }
        })
}

pub(super) fn select_generation_config(
    configs: &[ApiConfig],
    initially_selected: Option<&ApiConfig>,
    planned: ActiveGenerationModel,
    dedicated_ocr_ids: &HashSet<String>,
) -> Option<ApiConfig> {
    if let Some(selected) = initially_selected
        .filter(|config| generation_model_kind(config, dedicated_ocr_ids) == Some(planned))
    {
        return Some(selected.clone());
    }

    let mut candidates: Vec<&ApiConfig> = configs
        .iter()
        .filter(|config| generation_model_kind(config, dedicated_ocr_ids) == Some(planned))
        .collect();
    candidates.sort_by(|a, b| {
        b.is_favorite
            .cmp(&a.is_favorite)
            .then_with(|| b.is_builtin.cmp(&a.is_builtin))
            .then_with(|| a.id.cmp(&b.id))
    });
    candidates.first().map(|config| (*config).clone())
}

pub(super) fn resolve_strict_requested_model(
    strict: bool,
    requested_model_id: Option<&str>,
    configs: &[ApiConfig],
    dedicated_ocr_ids: &HashSet<String>,
) -> Result<Option<ApiConfig>, String> {
    if !strict {
        return Ok(None);
    }
    let model_id = requested_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("strict model selection requires a non-empty model configuration id")?;
    let config = configs
        .iter()
        .find(|config| config.id == model_id)
        .cloned()
        .ok_or_else(|| {
            format!(
                "Explicit persona model '{}' is unavailable; refusing to fall back to another model",
                model_id
            )
        })?;
    if generation_model_kind(&config, dedicated_ocr_ids).is_none() {
        return Err(format!(
            "Explicit persona model '{}' is disabled or is not a chat generation model; refusing to fall back",
            model_id
        ));
    }
    Ok(Some(config))
}

pub(super) fn apply_send_overrides(config: &mut ApiConfig, options: &SendOptions) {
    crate::llm_manager::routing::ParamOverrides {
        temperature: options.temperature,
        top_p: options.top_p,
        frequency_penalty: options.frequency_penalty,
        presence_penalty: options.presence_penalty,
        max_output_tokens: options.max_tokens,
    }
    .apply(config);
}

pub(super) fn requested_active_model_id(options: &SendOptions) -> Option<String> {
    options
        .model_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            options
                .model2_override_id
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
}

pub(super) fn canonical_content_for_freeze(
    existing: &[CanonicalContentPart],
    build: impl FnOnce() -> Vec<CanonicalContentPart>,
) -> Vec<CanonicalContentPart> {
    if existing.is_empty() {
        build()
    } else {
        existing.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::retrieval_planner::{
        plan_generation, CapabilitySnapshot, CapabilityState, GenerationRoute, QueryModality,
    };

    fn model_config(id: &str, enabled: bool, multimodal: bool) -> ApiConfig {
        ApiConfig {
            id: id.to_string(),
            model: format!("model-{id}"),
            enabled,
            is_multimodal: multimodal,
            ..ApiConfig::default()
        }
    }

    #[test]
    fn frozen_snapshot_is_owned_and_not_affected_by_later_option_changes() {
        let mut options = SendOptions {
            model_id: Some("before".to_string()),
            ..Default::default()
        };
        let requested = options.model_id.clone();
        options.model_id = Some("after".to_string());
        assert_eq!(requested.as_deref(), Some("before"));
    }

    #[test]
    fn freeze_preserves_retry_canonical_without_rebuilding_or_duplicating_parts() {
        let recovered = vec![
            CanonicalContentPart::Text {
                text: "same prompt".to_string(),
            },
            CanonicalContentPart::ImageRef {
                image_id: "img-1".to_string(),
                name: None,
                resource_id: Some("res-1".to_string()),
                source_id: Some("source-1".to_string()),
                blob_hash: Some("original-blob".to_string()),
                content_hash: None,
                mime_type: "image/png".to_string(),
                pinned: false,
                retrieval_hit: false,
            },
            CanonicalContentPart::DerivedArtifactRef {
                artifact_id: "artifact-1".to_string(),
                artifact_type: "ocr".to_string(),
                source_image_ids: vec!["img-1".to_string()],
                producer_model_id: None,
                content: "recognized".to_string(),
                created_at: 1,
            },
        ];

        let frozen = canonical_content_for_freeze(&recovered, || {
            panic!("retry canonical must not be rebuilt from empty context refs")
        });
        assert_eq!(frozen, recovered);
    }

    #[test]
    fn generic_mm_remains_auxiliary_even_when_also_used_as_ocr_fallback() {
        let mut generic = ApiConfig::default();
        generic.id = "generic-mm".to_string();
        generic.enabled = true;
        generic.is_multimodal = true;
        let generic_candidate = crate::llm_manager::OcrRuntimeCandidate::Remote {
            config: generic.clone(),
            engine_type: crate::ocr_adapters::OcrEngineType::GenericVlm,
        };
        assert!(!is_dedicated_ocr_candidate(&generic_candidate));

        // Only dedicated OCR engines belong in this exclusion set. A general MM referenced by
        // OCR settings is intentionally absent and remains eligible for visual observation.
        let dedicated = HashSet::from(["dedicated-ocr".to_string()]);
        assert!(auxiliary_mm_eligible(&generic, "active-tm", &dedicated));

        generic.id = "dedicated-ocr".to_string();
        assert!(!auxiliary_mm_eligible(&generic, "active-tm", &dedicated));
        assert!(is_dedicated_ocr_candidate(
            &crate::llm_manager::OcrRuntimeCandidate::SystemOcr
        ));

        let inferred_dedicated = ApiConfig {
            id: "unassigned-deepseek-ocr".to_string(),
            model: "deepseek-ai/DeepSeek-OCR".to_string(),
            enabled: true,
            is_multimodal: true,
            ..ApiConfig::default()
        };
        assert_eq!(
            generation_model_kind(&inferred_dedicated, &HashSet::new()),
            None,
            "a dedicated OCR protocol must never become Active MM merely because its assignment is temporarily absent"
        );
    }

    #[test]
    fn unavailable_requested_tm_reaches_an_available_mm_before_compilation() {
        let configs = vec![
            model_config("disabled-tm", false, false),
            model_config("available-mm", true, true),
        ];
        let requested = requested_generation_model(Some("disabled-tm"), None, &configs);
        assert_eq!(requested, Some(ActiveGenerationModel::Text));
        let snapshot = CapabilitySnapshot {
            text_model: CapabilityState::unavailable(),
            multimodal_model: CapabilityState::available(),
            ..Default::default()
        };
        let plan = plan_generation(&snapshot, requested, QueryModality::Mixed);
        assert_eq!(plan.active_model, Some(ActiveGenerationModel::Multimodal));
        assert_eq!(plan.fallback_from, Some(ActiveGenerationModel::Text));
        let active =
            select_generation_config(&configs, None, plan.active_model.unwrap(), &HashSet::new())
                .unwrap();
        assert_eq!(active.id, "available-mm");
    }

    #[test]
    fn strict_persona_model_requires_exact_enabled_config_id() {
        let configs = vec![
            model_config("disabled-local", false, false),
            model_config("available-cloud", true, false),
        ];
        let dedicated = HashSet::new();

        let missing =
            resolve_strict_requested_model(true, Some("missing-local"), &configs, &dedicated)
                .unwrap_err();
        assert!(missing.contains("refusing to fall back"));

        let disabled =
            resolve_strict_requested_model(true, Some("disabled-local"), &configs, &dedicated)
                .unwrap_err();
        assert!(disabled.contains("disabled"));

        let exact =
            resolve_strict_requested_model(true, Some("available-cloud"), &configs, &dedicated)
                .unwrap()
                .unwrap();
        assert_eq!(exact.id, "available-cloud");
        assert!(
            resolve_strict_requested_model(false, Some("missing-local"), &configs, &dedicated)
                .unwrap()
                .is_none(),
            "non-persona chat keeps its existing capability fallback behavior"
        );
    }

    #[test]
    fn unavailable_requested_mm_reaches_tm_with_ocr_shape() {
        let configs = vec![
            model_config("disabled-mm", false, true),
            model_config("available-tm", true, false),
        ];
        let requested = requested_generation_model(Some("disabled-mm"), None, &configs);
        let snapshot = CapabilitySnapshot {
            text_model: CapabilityState::available(),
            multimodal_model: CapabilityState::unavailable(),
            ocr: CapabilityState::available(),
            ..Default::default()
        };
        let plan = plan_generation(&snapshot, requested, QueryModality::Mixed);
        assert_eq!(plan.active_model, Some(ActiveGenerationModel::Text));
        assert_eq!(plan.route, GenerationRoute::OcrThenTextModel);
        let active =
            select_generation_config(&configs, None, plan.active_model.unwrap(), &HashSet::new())
                .unwrap();
        assert_eq!(active.id, "available-tm");
    }

    #[test]
    fn chat_model_id_wins_over_background_model2_override() {
        let options = SendOptions {
            model_id: Some("active-chat-mm".to_string()),
            model2_override_id: Some("background-tm".to_string()),
            ..Default::default()
        };
        assert_eq!(
            requested_active_model_id(&options).as_deref(),
            Some("active-chat-mm")
        );
    }

    #[test]
    fn text_model_prefers_auxiliary_mm_then_ocr() {
        let mut snapshot = CapabilitySnapshot {
            text_model: CapabilityState::available(),
            multimodal_model: CapabilityState::available(),
            ocr: CapabilityState::available(),
            ..Default::default()
        };
        let plan = plan_generation(
            &snapshot,
            Some(ActiveGenerationModel::Text),
            QueryModality::Mixed,
        );
        assert_eq!(
            plan.route,
            GenerationRoute::MultimodalObservationThenTextModel
        );
        assert!(!plan.uses_ocr);

        snapshot.multimodal_model = CapabilityState::unavailable();
        let fallback = plan_generation(
            &snapshot,
            Some(ActiveGenerationModel::Text),
            QueryModality::Mixed,
        );
        assert_eq!(fallback.route, GenerationRoute::OcrThenTextModel);
        assert!(fallback.uses_ocr);
    }
}
