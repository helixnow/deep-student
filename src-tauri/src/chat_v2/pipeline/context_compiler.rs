//! Capability-aware ChatV2 context compiler.
//!
//! The database keeps stable typed references. This module is the only place that turns image
//! bytes into request-local payloads and chooses MM -> auxiliary MM -> OCR fallback behavior.

use super::*;
use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::io::Write;

use crate::llm_manager::{ApiConfig, ImagePayload};
use crate::models::MultimodalContentPart;

use super::super::types::{CanonicalContentPart, ChatGenerationPlan, ModelExecutionSnapshot};
use crate::vfs::retrieval_planner::{
    plan_generation, ActiveGenerationModel, CapabilitySnapshot, CapabilityState, GenerationRoute,
    QueryModality,
};

pub(crate) const DEFAULT_IMAGE_BUDGET: usize = 8;
pub(crate) const DEFAULT_HISTORY_IMAGE_BUDGET: usize = 4;
const AUXILIARY_MM_STAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const OCR_STAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const VISUAL_PREPROCESS_TURN_BUDGET: std::time::Duration = std::time::Duration::from_secs(75);
const UNAVAILABLE_IMAGE_OBSERVATION: &str =
    "[图片内容当前不可解析：没有健康的多模态辅助模型或 OCR 引擎。原图引用已保留，可在能力恢复后重试。]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImageBudgetCandidate {
    pub message_index: usize,
    pub image_index: usize,
    pub turn_index: usize,
    pub is_current_turn: bool,
    pub pinned: bool,
    pub retrieval_hit: bool,
}

/// Select images deterministically. Current-turn and pinned images win, followed by recent
/// turns and retrieval hits. History has an independent ceiling so a long conversation cannot
/// crowd out the current turn.
pub(crate) fn select_images_with_budget(
    candidates: &[ImageBudgetCandidate],
    total_budget: usize,
    history_budget: usize,
) -> HashSet<(usize, usize)> {
    let mut ranked = candidates.to_vec();
    ranked.sort_by(|a, b| {
        b.is_current_turn
            .cmp(&a.is_current_turn)
            .then_with(|| b.pinned.cmp(&a.pinned))
            .then_with(|| b.turn_index.cmp(&a.turn_index))
            .then_with(|| b.retrieval_hit.cmp(&a.retrieval_hit))
            .then_with(|| a.message_index.cmp(&b.message_index))
            .then_with(|| a.image_index.cmp(&b.image_index))
    });

    let mut selected = HashSet::new();
    let mut history_count = 0usize;
    for candidate in ranked {
        if selected.len() >= total_budget {
            break;
        }
        if !candidate.is_current_turn {
            if history_count >= history_budget {
                continue;
            }
            history_count += 1;
        }
        selected.insert((candidate.message_index, candidate.image_index));
    }
    selected
}

#[derive(Clone)]
struct RuntimeImage {
    message_index: usize,
    image_index: usize,
    turn_index: usize,
    is_current_turn: bool,
    image_id: String,
    mime_type: String,
    base64: String,
    pinned: bool,
    retrieval_hit: bool,
}

#[derive(Debug, Clone)]
struct ResolvedCanonicalImage {
    mime_type: String,
    base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalVfsImage {
    image_id: String,
    source_id: String,
    blob_hash: Option<String>,
    content_hash: String,
    mime_type: String,
}

#[derive(Debug, Default)]
struct ReusedArtifactCoverage {
    covered_images: HashSet<(usize, usize)>,
    used_visual_observation: bool,
    used_ocr: bool,
}

fn auxiliary_mm_eligible(
    config: &ApiConfig,
    active_config_id: &str,
    dedicated_ocr_ids: &HashSet<String>,
) -> bool {
    generation_model_kind(config, dedicated_ocr_ids) == Some(ActiveGenerationModel::Multimodal)
        && config.id != active_config_id
}

fn is_dedicated_ocr_candidate(candidate: &crate::llm_manager::OcrRuntimeCandidate) -> bool {
    candidate.engine_type().is_dedicated_ocr()
}

fn generation_model_kind(
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

fn requested_generation_model(
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

fn select_generation_config(
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

fn apply_send_overrides(config: &mut ApiConfig, options: &SendOptions) {
    crate::llm_manager::routing::ParamOverrides {
        temperature: options.temperature,
        top_p: options.top_p,
        frequency_penalty: options.frequency_penalty,
        presence_penalty: options.presence_penalty,
        max_output_tokens: options.max_tokens,
    }
    .apply(config);
}

#[derive(Debug, PartialEq, Eq)]
enum PreprocessStageError<E> {
    Cancelled,
    TimedOut,
    Failed(E),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextImageCompileStrategy {
    NoImages,
    MultimodalDirect,
    TextModelPreprocess,
}

fn context_image_compile_strategy(
    resolved_model_is_multimodal: bool,
    has_images: bool,
) -> ContextImageCompileStrategy {
    match (has_images, resolved_model_is_multimodal) {
        (false, _) => ContextImageCompileStrategy::NoImages,
        (true, true) => ContextImageCompileStrategy::MultimodalDirect,
        (true, false) => ContextImageCompileStrategy::TextModelPreprocess,
    }
}

fn finalize_visual_observation(observation: Option<String>) -> (String, bool) {
    match observation {
        Some(observation) => (observation, true),
        None => (UNAVAILABLE_IMAGE_OBSERVATION.to_string(), false),
    }
}

async fn run_preprocess_stage<T, E, F, Fut>(
    parent_cancellation: Option<&tokio_util::sync::CancellationToken>,
    turn_deadline: tokio::time::Instant,
    stage_timeout: std::time::Duration,
    operation: F,
) -> Result<T, PreprocessStageError<E>>
where
    F: FnOnce(tokio_util::sync::CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let now = tokio::time::Instant::now();
    if now >= turn_deadline {
        return Err(PreprocessStageError::TimedOut);
    }
    let stage_deadline = std::cmp::min(turn_deadline, now + stage_timeout);
    let stage_cancellation = parent_cancellation
        .map(tokio_util::sync::CancellationToken::child_token)
        .unwrap_or_default();
    let cancellation_guard = stage_cancellation.clone().drop_guard();
    let future = operation(stage_cancellation.clone());
    let result = tokio::select! {
        biased;
        _ = stage_cancellation.cancelled() => Err(PreprocessStageError::Cancelled),
        result = tokio::time::timeout_at(stage_deadline, future) => match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(PreprocessStageError::Failed(error)),
            Err(_) => Err(PreprocessStageError::TimedOut),
        },
    };
    drop(cancellation_guard);
    result
}

fn requested_active_model_id(options: &SendOptions) -> Option<String> {
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

fn canonical_content_for_freeze(
    existing: &[CanonicalContentPart],
    build: impl FnOnce() -> Vec<CanonicalContentPart>,
) -> Vec<CanonicalContentPart> {
    if existing.is_empty() {
        build()
    } else {
        existing.to_vec()
    }
}

impl ChatV2Pipeline {
    /// Freeze model selection and all route-affecting capability facts before persistence or
    /// streaming starts. Mutating UI settings afterwards can only affect a later request.
    pub(crate) async fn freeze_execution_context(
        &self,
        ctx: &mut PipelineContext,
    ) -> ChatV2Result<()> {
        let requested_model_id = requested_active_model_id(&ctx.options);
        let ocr_candidates = self
            .llm_manager
            .get_free_text_ocr_candidates_by_priority()
            .await
            .unwrap_or_default();
        let ocr_available = ocr_candidates.iter().any(is_dedicated_ocr_candidate);
        let ocr_configs: Vec<_> = ocr_candidates
            .iter()
            .filter_map(|candidate| match candidate {
                crate::llm_manager::OcrRuntimeCandidate::Remote {
                    config,
                    engine_type,
                } => Some((config.clone(), *engine_type)),
                crate::llm_manager::OcrRuntimeCandidate::SystemOcr => None,
            })
            .collect();
        // A general-purpose MM may also be registered as an OCR fallback. It remains the best
        // auxiliary visual observer. Exclude only dedicated OCR protocols from MM selection.
        let dedicated_ocr_ids: HashSet<String> = ocr_configs
            .iter()
            .filter(|(_, engine)| engine.is_dedicated_ocr())
            .map(|(config, _)| config.id.clone())
            .collect();

        let all_configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|error| ChatV2Error::Llm(error.to_string()))?;
        // A disabled/deleted override is an input to capability planning, not an early fatal
        // error. The planner may resolve it to another model of the requested capability or to
        // the best remaining TM/MM capability.
        let initially_selected = self
            .llm_manager
            .select_model_for(
                "default",
                requested_model_id.clone(),
                ctx.options.temperature,
                ctx.options.top_p,
                ctx.options.frequency_penalty,
                ctx.options.presence_penalty,
                ctx.options.max_tokens,
            )
            .await
            .ok()
            .map(|(config, _)| config)
            .filter(|config| generation_model_kind(config, &dedicated_ocr_ids).is_some());

        let canonical_content = canonical_content_for_freeze(&ctx.canonical_content, || {
            self.build_canonical_current_content(ctx)
        });
        let has_images = canonical_content
            .iter()
            .any(|part| matches!(part, CanonicalContentPart::ImageRef { .. }));
        let requested_active = requested_generation_model(
            requested_model_id.as_deref(),
            initially_selected.as_ref(),
            &all_configs,
        );
        let text_model_available = all_configs.iter().any(|config| {
            generation_model_kind(config, &dedicated_ocr_ids) == Some(ActiveGenerationModel::Text)
        });
        let multimodal_model_available = all_configs.iter().any(|config| {
            generation_model_kind(config, &dedicated_ocr_ids)
                == Some(ActiveGenerationModel::Multimodal)
        });
        let capability_snapshot = CapabilitySnapshot {
            text_embedding: CapabilityState::unavailable(),
            multimodal_embedding: CapabilityState::unavailable(),
            text_model: if text_model_available {
                CapabilityState::available()
            } else {
                CapabilityState::unavailable()
            },
            multimodal_model: if multimodal_model_available {
                CapabilityState::available()
            } else {
                CapabilityState::unavailable()
            },
            ocr: if ocr_available {
                CapabilityState::available()
            } else {
                CapabilityState::unavailable()
            },
        };
        let planner = plan_generation(
            &capability_snapshot,
            requested_active,
            if has_images {
                QueryModality::Mixed
            } else {
                QueryModality::Text
            },
        );
        let planned_active = planner
            .active_model
            .ok_or_else(|| ChatV2Error::Llm("没有可用的文本或多模态生成模型".to_string()))?;
        let mut active = select_generation_config(
            &all_configs,
            initially_selected.as_ref(),
            planned_active,
            &dedicated_ocr_ids,
        )
        .ok_or_else(|| ChatV2Error::Llm("能力规划未解析到可执行模型".to_string()))?;
        apply_send_overrides(&mut active, &ctx.options);

        let mut auxiliary_candidates = Vec::new();
        let mut seen_auxiliary_ids = HashSet::new();

        // The OCR assignment list has an explicit user-controlled priority. General-purpose
        // VLMs in that list are visual observers, not dedicated OCR engines, so prefer them.
        for (config, engine) in &ocr_configs {
            if !engine.is_dedicated_ocr()
                && auxiliary_mm_eligible(config, &active.id, &dedicated_ocr_ids)
                && seen_auxiliary_ids.insert(config.id.clone())
            {
                auxiliary_candidates.push(config.clone());
            }
        }
        let mut remaining: Vec<ApiConfig> = all_configs
            .into_iter()
            .filter(|config| auxiliary_mm_eligible(config, &active.id, &dedicated_ocr_ids))
            .filter(|config| !seen_auxiliary_ids.contains(&config.id))
            .collect();
        remaining.sort_by(|a, b| {
            b.is_favorite
                .cmp(&a.is_favorite)
                .then_with(|| b.is_builtin.cmp(&a.is_builtin))
                .then_with(|| a.id.cmp(&b.id))
        });
        auxiliary_candidates.extend(remaining);
        let auxiliary = auxiliary_candidates.into_iter().next();
        let generation_plan = ChatGenerationPlan {
            planner,
            auxiliary_multimodal_config_id: auxiliary.as_ref().map(|config| config.id.clone()),
            image_budget: DEFAULT_IMAGE_BUDGET,
            history_image_budget: DEFAULT_HISTORY_IMAGE_BUDGET,
        };

        ctx.options.model_id = Some(active.id.clone());
        ctx.options.model2_override_id = Some(active.id.clone());
        ctx.model_display_name = Some(active.model.clone());
        ctx.canonical_content = canonical_content;
        ctx.execution_snapshot = Some(ModelExecutionSnapshot {
            requested_model_id,
            resolved_model_id: active.id,
            resolved_model_name: active.model,
            resolved_model_is_multimodal: active.is_multimodal,
            capability_snapshot,
            generation_plan,
            execution_route: None,
            frozen_at: chrono::Utc::now().timestamp_millis(),
        });
        Ok(())
    }

    fn build_canonical_current_content(&self, ctx: &PipelineContext) -> Vec<CanonicalContentPart> {
        let mut result = Vec::new();
        if !ctx.user_content.is_empty() {
            result.push(CanonicalContentPart::Text {
                text: ctx.user_content.clone(),
            });
        }

        let vfs_conn = self.vfs_db.as_ref().and_then(|db| db.get_conn_safe().ok());
        for context_ref in &ctx.user_context_refs {
            let is_pinned = ctx
                .options
                .group_pinned_resource_ids
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|id| id == &context_ref.resource_id));
            let persisted_images = vfs_conn
                .as_ref()
                .map(|conn| self.resolve_canonical_vfs_images(conn, &context_ref.resource_id));
            let persisted_images = persisted_images.unwrap_or_default();
            let mut saw_image = false;
            for image in persisted_images {
                saw_image = true;
                result.push(CanonicalContentPart::ImageRef {
                    image_id: image.image_id,
                    resource_id: Some(context_ref.resource_id.clone()),
                    source_id: Some(image.source_id),
                    blob_hash: image.blob_hash,
                    content_hash: Some(image.content_hash),
                    mime_type: image.mime_type,
                    pinned: is_pinned,
                    retrieval_hit: false,
                });
            }

            // Legacy/non-VFS payloads still get a deterministic descriptor. Request-local bytes
            // remain usable on this turn, while VFS-backed refs above are preferred for history.
            if !saw_image {
                for (image_offset, block) in context_ref
                    .formatted_blocks
                    .iter()
                    .filter(|block| matches!(block, ContentBlock::Image { .. }))
                    .enumerate()
                {
                    let ContentBlock::Image { media_type, .. } = block else {
                        continue;
                    };
                    saw_image = true;
                    result.push(CanonicalContentPart::ImageRef {
                        image_id: format!("{}:image:{}", context_ref.resource_id, image_offset),
                        resource_id: Some(context_ref.resource_id.clone()),
                        source_id: None,
                        blob_hash: None,
                        content_hash: Some(context_ref.hash.clone()),
                        mime_type: media_type.clone(),
                        pinned: is_pinned,
                        retrieval_hit: false,
                    });
                }
            }

            if !saw_image {
                result.push(CanonicalContentPart::FileRef {
                    file_id: context_ref.resource_id.clone(),
                    resource_id: Some(context_ref.resource_id.clone()),
                    blob_hash: None,
                    content_hash: Some(context_ref.hash.clone()),
                    mime_type: "application/octet-stream".to_string(),
                    name: context_ref.display_name.clone(),
                });
            }
        }
        result
    }

    fn resolve_canonical_vfs_images(
        &self,
        conn: &rusqlite::Connection,
        resource_id: &str,
    ) -> Vec<CanonicalVfsImage> {
        use crate::vfs::repos::VfsResourceRepo;
        use crate::vfs::types::{VfsContextRefData, VfsResourceType};

        let Ok(Some(resource)) = VfsResourceRepo::get_resource_with_conn(conn, resource_id) else {
            return Vec::new();
        };
        let Some(data) = resource.data else {
            return Vec::new();
        };
        let Ok(ref_data) = serde_json::from_str::<VfsContextRefData>(&data) else {
            return Vec::new();
        };

        let mut images = Vec::new();
        let mut seen = HashSet::new();
        for item in ref_data.refs {
            let source_resource_id = item.resource_id.as_deref().unwrap_or_default();
            let mut stmt = match conn.prepare(
                "SELECT u.resource_id, u.unit_index, u.image_blob_hash, u.image_mime_type
                 FROM vfs_index_units u
                 LEFT JOIN resources r ON r.id = u.resource_id
                 WHERE u.image_blob_hash IS NOT NULL
                   AND (u.resource_id IN (?1, ?2, ?3)
                        OR r.source_id IN (?1, ?2, ?3))
                 ORDER BY u.unit_index, u.id",
            ) {
                Ok(stmt) => stmt,
                Err(_) => continue,
            };
            let unit_images = stmt
                .query_map(
                    rusqlite::params![resource_id, item.source_id, source_resource_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i32>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .ok()
                .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
                .unwrap_or_default();
            for (_unit_resource_id, unit_index, blob_hash, mime_type) in unit_images {
                if seen.insert(blob_hash.clone()) {
                    images.push(CanonicalVfsImage {
                        image_id: format!("{}:{}:page:{}", resource_id, item.source_id, unit_index),
                        source_id: item.source_id.clone(),
                        content_hash: blob_hash.clone(),
                        blob_hash: Some(blob_hash),
                        mime_type: mime_type.unwrap_or_else(|| "image/png".to_string()),
                    });
                }
            }
            if images.iter().any(|image| image.source_id == item.source_id) {
                continue;
            }

            match item.resource_type {
                VfsResourceType::Image => {
                    let file: Option<(Option<String>, String, Option<String>)> = conn
                        .query_row(
                            "SELECT blob_hash, sha256, mime_type FROM files
                             WHERE id IN (?1, ?2) OR resource_id IN (?1, ?2)
                             ORDER BY CASE WHEN id = ?1 THEN 0 WHEN id = ?2 THEN 1 ELSE 2 END
                             LIMIT 1",
                            rusqlite::params![item.source_id, source_resource_id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .ok();
                    if let Some((blob_hash, content_hash, mime_type)) = file {
                        if blob_hash
                            .as_ref()
                            .is_none_or(|hash| seen.insert(hash.clone()))
                        {
                            images.push(CanonicalVfsImage {
                                image_id: format!("{}:{}", resource_id, item.source_id),
                                source_id: item.source_id,
                                blob_hash,
                                content_hash,
                                mime_type: mime_type.unwrap_or_else(|| "image/png".to_string()),
                            });
                        }
                    }
                }
                VfsResourceType::File | VfsResourceType::Textbook => {
                    let preview: Option<String> = conn
                        .query_row(
                            "SELECT preview_json FROM files
                             WHERE id IN (?1, ?2) OR resource_id IN (?1, ?2)
                             ORDER BY CASE WHEN id = ?1 THEN 0 WHEN id = ?2 THEN 1 ELSE 2 END
                             LIMIT 1",
                            rusqlite::params![item.source_id, source_resource_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();
                    append_preview_images(
                        &mut images,
                        &mut seen,
                        resource_id,
                        &item.source_id,
                        &item.resource_hash,
                        preview.as_deref(),
                    );
                }
                VfsResourceType::Exam => {
                    let preview: Option<String> = conn
                        .query_row(
                            "SELECT preview_json FROM exam_sheets WHERE id = ?1 LIMIT 1",
                            rusqlite::params![item.source_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();
                    append_preview_images(
                        &mut images,
                        &mut seen,
                        resource_id,
                        &item.source_id,
                        &item.resource_hash,
                        preview.as_deref(),
                    );
                }
                _ => {}
            }
        }
        images
    }

    /// Compile both history and current user content from the frozen snapshot. The resulting
    /// base64 payloads live only in `LegacyChatMessage` values for this request.
    pub(crate) async fn compile_frozen_context(
        &self,
        ctx: &mut PipelineContext,
    ) -> ChatV2Result<()> {
        let snapshot = ctx.execution_snapshot.clone().ok_or_else(|| {
            ChatV2Error::Other("model execution snapshot was not frozen".to_string())
        })?;

        let mut messages = ctx.chat_history.clone();
        let mut current_message = self.build_current_user_message(ctx);
        if !ctx.canonical_content.is_empty() {
            current_message.metadata = Some(serde_json::json!({
                "canonicalContent": ctx.canonical_content,
            }));
        }
        messages.push(current_message);
        let current_index = messages.len().saturating_sub(1);
        self.hydrate_canonical_images(&mut messages, current_index, &ctx.canonical_content);
        let all_runtime_images =
            collect_runtime_images(&messages, current_index, &ctx.canonical_content);
        let reused_artifacts = if snapshot.resolved_model_is_multimodal {
            ReusedArtifactCoverage::default()
        } else {
            apply_existing_derived_artifacts(&mut messages, &all_runtime_images)
        };
        let runtime_images: Vec<_> = all_runtime_images
            .iter()
            .filter(|image| {
                !reused_artifacts
                    .covered_images
                    .contains(&(image.message_index, image.image_index))
            })
            .cloned()
            .collect();
        let candidates: Vec<ImageBudgetCandidate> = runtime_images
            .iter()
            .map(|image| ImageBudgetCandidate {
                message_index: image.message_index,
                image_index: image.image_index,
                turn_index: image.turn_index,
                is_current_turn: image.is_current_turn,
                pinned: image.pinned,
                retrieval_hit: image.retrieval_hit,
            })
            .collect();
        let selected = select_images_with_budget(
            &candidates,
            snapshot.generation_plan.image_budget,
            snapshot.generation_plan.history_image_budget,
        );

        let actual_route = match context_image_compile_strategy(
            snapshot.resolved_model_is_multimodal,
            !all_runtime_images.is_empty(),
        ) {
            ContextImageCompileStrategy::NoImages => {
                strip_all_images(&mut messages, &selected, false);
                snapshot.generation_plan.planner.route
            }
            ContextImageCompileStrategy::MultimodalDirect => {
                retain_selected_images_for_multimodal(&mut messages, &selected);
                GenerationRoute::MultimodalModelDirect
            }
            ContextImageCompileStrategy::TextModelPreprocess => {
                self.compile_images_for_text_model(
                    ctx,
                    &mut messages,
                    &runtime_images,
                    &selected,
                    reused_artifacts,
                )
                .await?
            }
        };

        let current = messages
            .pop()
            .unwrap_or_else(|| self.build_current_user_message(ctx));
        ctx.chat_history = messages;
        ctx.compiled_current_user_message = Some(current);
        if let Some(frozen) = &mut ctx.execution_snapshot {
            frozen.execution_route = Some(actual_route);
        }
        Ok(())
    }

    /// Resolve stable ImageRef/blob hashes into request-local payloads. Canonical bytes override
    /// formattedBlocks/preview base64 because those may be compressed or temporary.
    fn hydrate_canonical_images(
        &self,
        messages: &mut [LegacyChatMessage],
        current_index: usize,
        current_canonical: &[CanonicalContentPart],
    ) {
        for (message_index, message) in messages.iter_mut().enumerate() {
            let canonical: Option<Vec<CanonicalContentPart>> = if message_index == current_index {
                Some(current_canonical.to_vec())
            } else {
                canonical_content_from_message_metadata(message)
            };
            let Some(canonical) = canonical else {
                continue;
            };
            let payloads = self.resolve_canonical_image_payloads(&canonical);
            override_message_images_with_canonical(message, &payloads);
        }
    }

    fn resolve_canonical_image_payloads(
        &self,
        canonical: &[CanonicalContentPart],
    ) -> Vec<Option<ResolvedCanonicalImage>> {
        use crate::vfs::repos::VfsBlobRepo;

        let image_count = canonical
            .iter()
            .filter(|part| matches!(part, CanonicalContentPart::ImageRef { .. }))
            .count();
        let Some(vfs_db) = self.vfs_db.as_ref() else {
            return vec![None; image_count];
        };
        let Ok(conn) = vfs_db.get_conn_safe() else {
            return vec![None; image_count];
        };

        canonical
            .iter()
            .filter_map(|part| match part {
                CanonicalContentPart::ImageRef {
                    blob_hash,
                    source_id,
                    mime_type,
                    ..
                } => Some((blob_hash, source_id, mime_type)),
                _ => None,
            })
            .map(|(blob_hash, source_id, mime_type)| {
                let resolved_hash = blob_hash.clone().or_else(|| {
                    let source_id = source_id.as_deref()?;
                    conn.query_row(
                        "SELECT blob_hash FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1",
                        rusqlite::params![source_id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten()
                });
                let hash = resolved_hash?;
                let path = VfsBlobRepo::get_blob_path_with_conn(&conn, vfs_db.blobs_dir(), &hash)
                    .ok()
                    .flatten()?;
                let bytes = std::fs::read(path).ok()?;
                Some(ResolvedCanonicalImage {
                    mime_type: mime_type.clone(),
                    base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                })
            })
            .collect()
    }

    async fn compile_images_for_text_model(
        &self,
        ctx: &mut PipelineContext,
        messages: &mut [LegacyChatMessage],
        images: &[RuntimeImage],
        selected: &HashSet<(usize, usize)>,
        reused_artifacts: ReusedArtifactCoverage,
    ) -> ChatV2Result<GenerationRoute> {
        let frozen = ctx.execution_snapshot.clone().expect("snapshot checked");
        let auxiliary_id = frozen
            .generation_plan
            .auxiliary_multimodal_config_id
            .clone();
        let ocr_available = frozen.capability_snapshot.ocr.runtime_available();
        let mut used_auxiliary = reused_artifacts.used_visual_observation;
        let mut used_ocr = reused_artifacts.used_ocr;
        let mut unavailable = !images.is_empty() && selected.is_empty();
        let cancellation_token = ctx.cancellation_token().cloned();
        let turn_deadline = tokio::time::Instant::now() + VISUAL_PREPROCESS_TURN_BUDGET;

        let mut by_message: HashMap<usize, Vec<&RuntimeImage>> = HashMap::new();
        for image in images {
            if selected.contains(&(image.message_index, image.image_index)) {
                by_message
                    .entry(image.message_index)
                    .or_default()
                    .push(image);
            }
        }

        // Newer/current messages have larger indexes. Process them first so a shared turn
        // deadline cannot be consumed nondeterministically by old history.
        let mut message_indexes: Vec<usize> = by_message.keys().copied().collect();
        message_indexes.sort_unstable_by(|a, b| b.cmp(a));
        for message_index in message_indexes {
            let selected_images = &by_message[&message_index];
            let mut observation = None;
            let mut artifact_type = "visual_observation";
            let mut producer_model_id = None;
            if let Some(auxiliary_id) = auxiliary_id.as_deref() {
                let payloads = selected_images
                    .iter()
                    .map(|image| ImagePayload {
                        mime: image.mime_type.clone(),
                        base64: image.base64.clone(),
                    })
                    .collect();
                match run_preprocess_stage(
                    cancellation_token.as_ref(),
                    turn_deadline,
                    AUXILIARY_MM_STAGE_TIMEOUT,
                    |stage_cancellation| {
                        self.llm_manager
                            .call_raw_prompt_with_config_id_and_images_cancellable(
                                auxiliary_id,
                                "请直接观察图片并给出忠实、紧凑的视觉描述，包含与对话相关的文字、结构、对象和关系。不要臆测。",
                                payloads,
                                crate::llm_usage::CallerType::ChatV2,
                                stage_cancellation,
                            )
                    },
                )
                .await
                {
                    Ok(output) if !output.assistant_message.trim().is_empty() => {
                        observation = Some(output.assistant_message);
                        producer_model_id = Some(auxiliary_id.to_string());
                        used_auxiliary = true;
                    }
                    Ok(_) => log::warn!(
                        "[ChatV2::ContextCompiler] auxiliary MM returned an empty observation"
                    ),
                    Err(PreprocessStageError::Failed(error)) => log::warn!(
                        "[ChatV2::ContextCompiler] auxiliary MM failed, falling back to OCR: {}",
                        error
                    ),
                    Err(PreprocessStageError::TimedOut) => log::warn!(
                        "[ChatV2::ContextCompiler] auxiliary MM timed out, falling back to OCR"
                    ),
                    Err(PreprocessStageError::Cancelled) => {
                        return Err(ChatV2Error::Cancelled);
                    }
                }
            }

            if observation.is_none() && ocr_available {
                let mut ocr_texts = Vec::new();
                for image in selected_images {
                    match run_preprocess_stage(
                        cancellation_token.as_ref(),
                        turn_deadline,
                        OCR_STAGE_TIMEOUT,
                        |stage_cancellation| self.ocr_runtime_image(image, stage_cancellation),
                    )
                    .await
                    {
                        Ok(text) if !text.trim().is_empty() => ocr_texts.push(text),
                        Ok(_) => {}
                        Err(PreprocessStageError::Failed(error)) => log::warn!(
                            "[ChatV2::ContextCompiler] OCR fallback failed for {}: {}",
                            image.image_id,
                            error
                        ),
                        Err(PreprocessStageError::TimedOut) => log::warn!(
                            "[ChatV2::ContextCompiler] OCR fallback timed out for {}",
                            image.image_id
                        ),
                        Err(PreprocessStageError::Cancelled) => {
                            return Err(ChatV2Error::Cancelled);
                        }
                    }
                }
                if !ocr_texts.is_empty() {
                    observation = Some(ocr_texts.join("\n\n"));
                    artifact_type = "ocr_text";
                    used_ocr = true;
                }
            }

            let (observation, reusable_artifact) = finalize_visual_observation(observation);
            if !reusable_artifact {
                unavailable = true;
            }
            append_observation(&mut messages[message_index], &observation);

            // An unavailable placeholder is request-local. Persisting it as a canonical artifact
            // would permanently suppress retries after MM/OCR capability recovers.
            if reusable_artifact && message_index == messages.len().saturating_sub(1) {
                let source_image_ids = selected_images
                    .iter()
                    .map(|image| image.image_id.clone())
                    .collect();
                ctx.canonical_content
                    .push(CanonicalContentPart::DerivedArtifactRef {
                        artifact_id: format!("artifact_{}", uuid::Uuid::new_v4()),
                        artifact_type: artifact_type.to_string(),
                        source_image_ids,
                        producer_model_id,
                        content: observation,
                        created_at: chrono::Utc::now().timestamp_millis(),
                    });
            }
        }

        let mut handled_images = selected.clone();
        handled_images.extend(reused_artifacts.covered_images);
        strip_all_images(messages, &handled_images, true);
        Ok(if unavailable {
            GenerationRoute::TextModelWithoutImage
        } else if used_ocr {
            GenerationRoute::OcrThenTextModel
        } else if used_auxiliary {
            GenerationRoute::MultimodalObservationThenTextModel
        } else {
            GenerationRoute::TextModelDirect
        })
    }

    async fn ocr_runtime_image(
        &self,
        image: &RuntimeImage,
        cancellation_token: tokio_util::sync::CancellationToken,
    ) -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.base64)
            .map_err(|error| format!("invalid image base64: {}", error))?;
        let suffix = match image.mime_type.as_str() {
            "image/png" => ".png",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            _ => ".jpg",
        };
        let mut file = tempfile::Builder::new()
            .prefix("chat-v2-ocr-")
            .suffix(suffix)
            .tempfile()
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        let path = file
            .path()
            .to_str()
            .ok_or_else(|| "temporary OCR path is not UTF-8".to_string())?;
        self.llm_manager
            .call_dedicated_ocr_free_text_with_fallback(path, cancellation_token)
            .await
            .map_err(|error| error.to_string())
    }
}

fn canonical_content_from_message_metadata(
    message: &LegacyChatMessage,
) -> Option<Vec<CanonicalContentPart>> {
    message
        .metadata
        .as_ref()
        .and_then(|value| value.get("canonicalContent"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn append_preview_images(
    images: &mut Vec<CanonicalVfsImage>,
    seen: &mut HashSet<String>,
    container_resource_id: &str,
    source_id: &str,
    fallback_content_hash: &str,
    preview_json: Option<&str>,
) {
    let Some(preview_json) = preview_json.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let Ok(preview) = serde_json::from_str::<serde_json::Value>(preview_json) else {
        return;
    };
    let Some(pages) = preview.get("pages").and_then(serde_json::Value::as_array) else {
        return;
    };
    for (fallback_page_index, page) in pages.iter().enumerate() {
        let Some(blob_hash) = page
            .get("blobHash")
            .or_else(|| page.get("blob_hash"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !seen.insert(blob_hash.to_string()) {
            continue;
        }
        let page_index = page
            .get("pageIndex")
            .or_else(|| page.get("page_index"))
            .and_then(serde_json::Value::as_i64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(fallback_page_index);
        let mime_type = page
            .get("mimeType")
            .or_else(|| page.get("mime_type"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("image/png")
            .to_string();
        images.push(CanonicalVfsImage {
            image_id: format!(
                "{}:{}:page:{}",
                container_resource_id, source_id, page_index
            ),
            source_id: source_id.to_string(),
            blob_hash: Some(blob_hash.to_string()),
            content_hash: if blob_hash.is_empty() {
                fallback_content_hash.to_string()
            } else {
                blob_hash.to_string()
            },
            mime_type,
        });
    }
}

fn collect_runtime_images(
    messages: &[LegacyChatMessage],
    current_index: usize,
    current_canonical: &[CanonicalContentPart],
) -> Vec<RuntimeImage> {
    let descriptors = |canonical: &[CanonicalContentPart]| {
        canonical
            .iter()
            .filter_map(|part| match part {
                CanonicalContentPart::ImageRef {
                    image_id,
                    mime_type,
                    pinned,
                    retrieval_hit,
                    ..
                } => Some((image_id.clone(), mime_type.clone(), *pinned, *retrieval_hit)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let current_refs = descriptors(current_canonical);

    let mut result = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        let history_canonical: Vec<CanonicalContentPart> = message
            .metadata
            .as_ref()
            .and_then(|value| value.get("canonicalContent"))
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        let history_refs = descriptors(&history_canonical);
        let canonical_refs = if message_index == current_index {
            &current_refs
        } else {
            &history_refs
        };
        let mut image_index = 0usize;
        if let Some(parts) = &message.multimodal_content {
            for part in parts {
                if let MultimodalContentPart::ImageUrl { media_type, base64 } = part {
                    let (image_id, canonical_mime, pinned, retrieval_hit) =
                        canonical_refs.get(image_index).cloned().unwrap_or_else(|| {
                            if message_index == current_index {
                                (
                                    format!("current:image:{}", image_index),
                                    media_type.clone(),
                                    false,
                                    false,
                                )
                            } else {
                                (
                                    format!("history:{}:image:{}", message_index, image_index),
                                    media_type.clone(),
                                    false,
                                    false,
                                )
                            }
                        });
                    result.push(RuntimeImage {
                        message_index,
                        image_index,
                        turn_index: message_index,
                        is_current_turn: message_index == current_index,
                        image_id,
                        mime_type: canonical_mime,
                        base64: base64.clone(),
                        pinned,
                        retrieval_hit,
                    });
                    image_index += 1;
                }
            }
        } else if let Some(images) = &message.image_base64 {
            for base64 in images {
                let (image_id, mime_type, pinned, retrieval_hit) =
                    canonical_refs.get(image_index).cloned().unwrap_or_else(|| {
                        if message_index == current_index {
                            (
                                format!("current:image:{}", image_index),
                                "image/jpeg".to_string(),
                                false,
                                false,
                            )
                        } else {
                            (
                                format!("history:{}:image:{}", message_index, image_index),
                                "image/jpeg".to_string(),
                                false,
                                false,
                            )
                        }
                    });
                result.push(RuntimeImage {
                    message_index,
                    image_index,
                    turn_index: message_index,
                    is_current_turn: message_index == current_index,
                    image_id,
                    mime_type,
                    base64: base64.clone(),
                    pinned,
                    retrieval_hit,
                });
                image_index += 1;
            }
        }
    }
    result
}

fn apply_existing_derived_artifacts(
    messages: &mut [LegacyChatMessage],
    images: &[RuntimeImage],
) -> ReusedArtifactCoverage {
    let mut result = ReusedArtifactCoverage::default();
    // `image_id` is stable for a canonical Blob and may legitimately repeat when the user
    // references the same image in several turns. Scope the lookup to its owning message so a
    // later occurrence cannot shadow an earlier turn's derived artifact.
    let mut image_indexes_by_message_and_id: HashMap<(usize, &str), usize> = HashMap::new();
    for image in images {
        image_indexes_by_message_and_id.insert(
            (image.message_index, image.image_id.as_str()),
            image.image_index,
        );
    }

    for message_index in 0..messages.len() {
        let canonical: Vec<CanonicalContentPart> = messages[message_index]
            .metadata
            .as_ref()
            .and_then(|value| value.get("canonicalContent"))
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        let mut observations = Vec::new();
        let mut appended_artifact_ids = HashSet::new();
        for part in canonical.into_iter().rev() {
            let CanonicalContentPart::DerivedArtifactRef {
                artifact_id,
                artifact_type,
                source_image_ids,
                content,
                ..
            } = part
            else {
                continue;
            };
            if content.trim().is_empty() || !appended_artifact_ids.insert(artifact_id) {
                continue;
            }
            let newly_covered: Vec<(usize, usize)> = source_image_ids
                .iter()
                .filter_map(|image_id| {
                    image_indexes_by_message_and_id
                        .get(&(message_index, image_id.as_str()))
                        .copied()
                        .map(|image_index| (message_index, image_index))
                })
                .filter(|key| !result.covered_images.contains(key))
                .collect();
            if newly_covered.is_empty() {
                continue;
            }
            result.covered_images.extend(newly_covered);
            if artifact_type == "ocr_text" {
                result.used_ocr = true;
            } else {
                result.used_visual_observation = true;
            }
            observations.push(content);
        }
        for observation in observations.into_iter().rev() {
            append_observation(&mut messages[message_index], &observation);
        }
    }
    result
}

fn override_message_images_with_canonical(
    message: &mut LegacyChatMessage,
    canonical: &[Option<ResolvedCanonicalImage>],
) {
    if canonical.is_empty() {
        return;
    }

    let mut replaced = 0usize;
    if let Some(parts) = message.multimodal_content.as_mut() {
        let mut image_index = 0usize;
        for part in parts {
            if let MultimodalContentPart::ImageUrl { media_type, base64 } = part {
                if let Some(Some(payload)) = canonical.get(image_index) {
                    *media_type = payload.mime_type.clone();
                    *base64 = payload.base64.clone();
                    replaced += 1;
                }
                image_index += 1;
            }
        }
    } else if let Some(images) = message.image_base64.take() {
        let mut parts = vec![MultimodalContentPart::text(message.content.clone())];
        for (image_index, legacy_base64) in images.into_iter().enumerate() {
            if let Some(Some(payload)) = canonical.get(image_index) {
                parts.push(MultimodalContentPart::image(
                    payload.mime_type.clone(),
                    payload.base64.clone(),
                ));
                replaced += 1;
            } else {
                parts.push(MultimodalContentPart::image("image/jpeg", legacy_base64));
            }
        }
        message.multimodal_content = Some(parts);
    } else {
        let resolved: Vec<_> = canonical.iter().filter_map(Option::as_ref).collect();
        if !resolved.is_empty() {
            let mut parts = vec![MultimodalContentPart::text(message.content.clone())];
            for payload in resolved {
                parts.push(MultimodalContentPart::image(
                    payload.mime_type.clone(),
                    payload.base64.clone(),
                ));
                replaced += 1;
            }
            message.multimodal_content = Some(parts);
        }
    }

    if replaced > 0 {
        log::debug!(
            "[ChatV2::ContextCompiler] replaced {} preview image payload(s) with canonical blob bytes",
            replaced
        );
    }
}

fn retain_selected_images_for_multimodal(
    messages: &mut [LegacyChatMessage],
    selected: &HashSet<(usize, usize)>,
) {
    for (message_index, message) in messages.iter_mut().enumerate() {
        if let Some(parts) = message.multimodal_content.take() {
            let mut image_index = 0usize;
            let mut kept = Vec::new();
            let mut dropped = 0usize;
            for part in parts {
                match part {
                    MultimodalContentPart::ImageUrl { .. } => {
                        if selected.contains(&(message_index, image_index)) {
                            kept.push(part);
                        } else {
                            dropped += 1;
                        }
                        image_index += 1;
                    }
                    _ => kept.push(part),
                }
            }
            if dropped > 0 {
                kept.push(MultimodalContentPart::text(format!(
                    "[{} 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]",
                    dropped
                )));
            }
            message.multimodal_content = Some(kept);
            message.image_base64 = None;
        } else if let Some(images) = message.image_base64.take() {
            let mut parts = vec![MultimodalContentPart::text(message.content.clone())];
            let mut dropped = 0usize;
            for (image_index, image) in images.into_iter().enumerate() {
                if selected.contains(&(message_index, image_index)) {
                    parts.push(MultimodalContentPart::image("image/jpeg", image));
                } else {
                    dropped += 1;
                }
            }
            if dropped > 0 {
                parts.push(MultimodalContentPart::text(format!(
                    "[{} 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]",
                    dropped
                )));
            }
            message.multimodal_content = Some(parts);
        }
    }
}

fn strip_all_images(
    messages: &mut [LegacyChatMessage],
    selected: &HashSet<(usize, usize)>,
    add_budget_placeholder: bool,
) {
    for (message_index, message) in messages.iter_mut().enumerate() {
        let image_count = message
            .multimodal_content
            .as_ref()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|part| matches!(part, MultimodalContentPart::ImageUrl { .. }))
                    .count()
            })
            .or_else(|| message.image_base64.as_ref().map(Vec::len))
            .unwrap_or(0);
        let dropped = (0..image_count)
            .filter(|image_index| !selected.contains(&(message_index, *image_index)))
            .count();
        message.image_base64 = None;
        if let Some(parts) = message.multimodal_content.take() {
            let text = parts
                .into_iter()
                .filter_map(|part| match part {
                    MultimodalContentPart::Text { text } => Some(text),
                    MultimodalContentPart::ImageUrl { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if message.content.trim().is_empty() {
                message.content = text;
            }
        }
        if add_budget_placeholder && dropped > 0 {
            message.content.push_str(&format!(
                "\n[{} 张较早图片因上下文图片预算未处理；原始引用仍保留。]",
                dropped
            ));
        }
    }
}

fn append_observation(message: &mut LegacyChatMessage, observation: &str) {
    message.content.push_str(&format!(
        "\n\n<derived_visual_observation>\n{}\n</derived_visual_observation>",
        observation
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn model_config(id: &str, enabled: bool, multimodal: bool) -> ApiConfig {
        ApiConfig {
            id: id.to_string(),
            model: format!("model-{id}"),
            enabled,
            is_multimodal: multimodal,
            ..ApiConfig::default()
        }
    }

    fn candidate(
        message: usize,
        image: usize,
        turn: usize,
        current: bool,
        pinned: bool,
    ) -> ImageBudgetCandidate {
        ImageBudgetCandidate {
            message_index: message,
            image_index: image,
            turn_index: turn,
            is_current_turn: current,
            pinned,
            retrieval_hit: false,
        }
    }

    fn canonical_user_message(
        content: &str,
        canonical: Vec<CanonicalContentPart>,
    ) -> LegacyChatMessage {
        LegacyChatMessage {
            role: "user".to_string(),
            content: content.to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: Some(vec![format!("bytes-{content}")]),
            doc_attachments: None,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: Some(serde_json::json!({ "canonicalContent": canonical })),
        }
    }

    #[test]
    fn image_budget_prioritizes_current_pinned_and_recent_history() {
        let candidates = vec![
            candidate(0, 0, 0, false, false),
            candidate(1, 0, 1, false, true),
            candidate(2, 0, 2, false, false),
            candidate(3, 0, 3, true, false),
            candidate(3, 1, 3, true, false),
        ];
        let selected = select_images_with_budget(&candidates, 3, 1);
        assert!(selected.contains(&(3, 0)));
        assert!(selected.contains(&(3, 1)));
        assert!(selected.contains(&(1, 0)));
        assert!(!selected.contains(&(2, 0)));
    }

    #[test]
    fn multimodal_compiler_keeps_raw_images_without_ocr_text() {
        assert_eq!(
            context_image_compile_strategy(true, true),
            ContextImageCompileStrategy::MultimodalDirect
        );
        let mut messages = vec![LegacyChatMessage {
            role: "user".to_string(),
            content: "look".to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: Some(vec!["raw".to_string()]),
            doc_attachments: None,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        }];
        retain_selected_images_for_multimodal(&mut messages, &HashSet::from([(0, 0)]));
        assert!(messages[0].image_base64.is_none());
        let parts = messages[0].multimodal_content.as_ref().unwrap();
        assert!(parts.iter().any(
            |part| matches!(part, MultimodalContentPart::ImageUrl { base64, .. } if base64 == "raw")
        ));
        assert!(!messages[0].content.contains("OCR"));
    }

    #[test]
    fn unavailable_visual_placeholder_is_never_a_reusable_artifact() {
        let (placeholder, reusable) = finalize_visual_observation(None);
        assert_eq!(placeholder, UNAVAILABLE_IMAGE_OBSERVATION);
        assert!(!reusable);

        let (observation, reusable) =
            finalize_visual_observation(Some("actual observation".to_string()));
        assert_eq!(observation, "actual observation");
        assert!(reusable);
    }

    #[test]
    fn canonical_blob_payload_overrides_different_preview_base64_for_mm() {
        let mut message = LegacyChatMessage {
            role: "user".to_string(),
            content: "inspect".to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: Some(vec!["compressed-preview".to_string()]),
            doc_attachments: None,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        };
        override_message_images_with_canonical(
            &mut message,
            &[Some(ResolvedCanonicalImage {
                mime_type: "image/png".to_string(),
                base64: "original-blob".to_string(),
            })],
        );
        assert!(message.image_base64.is_none());
        assert!(message.multimodal_content.as_ref().unwrap().iter().any(
            |part| matches!(part, MultimodalContentPart::ImageUrl { media_type, base64 }
                if media_type == "image/png" && base64 == "original-blob")
        ));
    }

    #[test]
    fn execution_snapshot_round_trips_and_old_meta_remains_compatible() {
        let snapshot = ModelExecutionSnapshot {
            requested_model_id: Some("tm".to_string()),
            resolved_model_id: "mm".to_string(),
            resolved_model_name: "Vision".to_string(),
            resolved_model_is_multimodal: true,
            capability_snapshot: CapabilitySnapshot {
                multimodal_model: CapabilityState::available(),
                ..Default::default()
            },
            generation_plan: ChatGenerationPlan {
                planner: crate::vfs::retrieval_planner::GenerationPlan {
                    route: GenerationRoute::MultimodalModelDirect,
                    active_model: Some(ActiveGenerationModel::Multimodal),
                    fallback_from: None,
                    sends_original_images: true,
                    uses_ocr: false,
                    degraded: false,
                },
                auxiliary_multimodal_config_id: None,
                image_budget: 8,
                history_image_budget: 4,
            },
            execution_route: Some(GenerationRoute::MultimodalModelDirect),
            frozen_at: 42,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(
            serde_json::from_str::<ModelExecutionSnapshot>(&json).unwrap(),
            snapshot
        );

        let old: super::super::super::types::MessageMeta =
            serde_json::from_str(r#"{"modelId":"legacy"}"#).unwrap();
        assert!(old.execution_snapshot.is_none());
        assert!(old.canonical_content.is_none());
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
    fn tm_mm_alternating_turns_recompile_the_same_original_image() {
        let canonical = vec![CanonicalContentPart::ImageRef {
            image_id: "img-1".to_string(),
            resource_id: Some("res-1".to_string()),
            source_id: Some("source-1".to_string()),
            blob_hash: Some("blob-original".to_string()),
            content_hash: Some("content-original".to_string()),
            mime_type: "image/png".to_string(),
            pinned: false,
            retrieval_hit: false,
        }];
        for active_mm in [false, true, false, true] {
            // Each turn starts from persisted canonical metadata and resolves the same Blob
            // payload. It never clones the previous turn's flattened TM/MM request shape.
            let mut message = LegacyChatMessage {
                role: "user".to_string(),
                content: "question".to_string(),
                timestamp: chrono::Utc::now(),
                thinking_content: None,
                thought_signature: None,
                rag_sources: None,
                memory_sources: None,
                graph_sources: None,
                web_search_sources: None,
                image_paths: None,
                image_base64: Some(vec!["compressed-preview".to_string()]),
                doc_attachments: None,
                multimodal_content: None,
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: None,
                metadata: Some(serde_json::json!({ "canonicalContent": canonical })),
            };
            let recovered = canonical_content_from_message_metadata(&message).unwrap();
            assert!(matches!(
                &recovered[0],
                CanonicalContentPart::ImageRef { blob_hash: Some(hash), .. }
                    if hash == "blob-original"
            ));
            override_message_images_with_canonical(
                &mut message,
                &[Some(ResolvedCanonicalImage {
                    mime_type: "image/png".to_string(),
                    base64: "original-image".to_string(),
                })],
            );
            let mut messages = vec![message];
            if active_mm {
                retain_selected_images_for_multimodal(&mut messages, &HashSet::from([(0, 0)]));
                assert!(messages[0].multimodal_content.as_ref().unwrap().iter().any(
                    |part| matches!(part, MultimodalContentPart::ImageUrl { base64, .. }
                        if base64 == "original-image")
                ));
                assert!(!messages[0].content.contains("visual observation"));
                assert!(!messages[0].content.contains("OCR"));
            } else {
                append_observation(&mut messages[0], "visual observation");
                strip_all_images(&mut messages, &HashSet::from([(0, 0)]), true);
                assert!(messages[0].image_base64.is_none());
                assert!(messages[0].multimodal_content.is_none());
                assert!(messages[0].content.contains("visual observation"));
            }
        }
    }

    #[test]
    fn repeated_canonical_image_ids_reuse_each_turns_own_artifact() {
        let canonical_for = |artifact_id: &str, observation: &str| {
            vec![
                CanonicalContentPart::ImageRef {
                    image_id: "stable-image-id".to_string(),
                    resource_id: Some("res-1".to_string()),
                    source_id: Some("source-1".to_string()),
                    blob_hash: Some("same-blob".to_string()),
                    content_hash: Some("same-content".to_string()),
                    mime_type: "image/png".to_string(),
                    pinned: false,
                    retrieval_hit: false,
                },
                CanonicalContentPart::DerivedArtifactRef {
                    artifact_id: artifact_id.to_string(),
                    artifact_type: "visual_observation".to_string(),
                    source_image_ids: vec!["stable-image-id".to_string()],
                    producer_model_id: Some("observer-mm".to_string()),
                    content: observation.to_string(),
                    created_at: 1,
                },
            ]
        };
        let mut messages = vec![
            canonical_user_message(
                "first",
                canonical_for("artifact-first", "first observation"),
            ),
            canonical_user_message(
                "second",
                canonical_for("artifact-second", "second observation"),
            ),
        ];
        let images = vec![
            RuntimeImage {
                message_index: 0,
                image_index: 0,
                turn_index: 0,
                is_current_turn: false,
                image_id: "stable-image-id".to_string(),
                mime_type: "image/png".to_string(),
                base64: "bytes-first".to_string(),
                pinned: false,
                retrieval_hit: false,
            },
            RuntimeImage {
                message_index: 1,
                image_index: 0,
                turn_index: 1,
                is_current_turn: true,
                image_id: "stable-image-id".to_string(),
                mime_type: "image/png".to_string(),
                base64: "bytes-second".to_string(),
                pinned: false,
                retrieval_hit: false,
            },
        ];

        let reused = apply_existing_derived_artifacts(&mut messages, &images);

        assert_eq!(reused.covered_images, HashSet::from([(0, 0), (1, 0)]));
        assert!(messages[0].content.contains("first observation"));
        assert!(!messages[0].content.contains("second observation"));
        assert!(messages[1].content.contains("second observation"));
        assert!(!messages[1].content.contains("first observation"));
    }

    #[tokio::test]
    async fn auxiliary_timeout_advances_to_ocr_within_the_turn_budget() {
        let turn_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
        let auxiliary = run_preprocess_stage(
            None,
            turn_deadline,
            std::time::Duration::from_millis(5),
            |_| async { std::future::pending::<Result<&'static str, &'static str>>().await },
        )
        .await;
        assert_eq!(auxiliary, Err(PreprocessStageError::TimedOut));

        let ocr = run_preprocess_stage(
            None,
            turn_deadline,
            std::time::Duration::from_millis(50),
            |_| async { Ok::<_, &'static str>("recognized") },
        )
        .await;
        assert_eq!(ocr, Ok("recognized"));
    }

    #[tokio::test]
    async fn preprocessing_turn_budget_caps_a_long_stage_and_cancels_its_work() {
        let observed = Arc::new(AtomicBool::new(false));
        let observed_by_task = observed.clone();
        let result = run_preprocess_stage(
            None,
            tokio::time::Instant::now() + std::time::Duration::from_millis(5),
            std::time::Duration::from_secs(1),
            move |stage_cancellation| async move {
                tokio::spawn(async move {
                    stage_cancellation.cancelled().await;
                    observed_by_task.store(true, Ordering::SeqCst);
                });
                std::future::pending::<Result<(), &'static str>>().await
            },
        )
        .await;
        assert_eq!(result, Err(PreprocessStageError::TimedOut));
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            while !observed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stage cancellation must reach spawned provider work");
    }

    #[tokio::test]
    async fn parent_cancellation_stops_preprocessing_before_fallback() {
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let operation_polled = Arc::new(AtomicBool::new(false));
        let operation_polled_by_future = operation_polled.clone();
        let result = run_preprocess_stage(
            Some(&cancellation),
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(1),
            move |_| async move {
                operation_polled_by_future.store(true, Ordering::SeqCst);
                Ok::<_, &'static str>(())
            },
        )
        .await;
        assert_eq!(result, Err(PreprocessStageError::Cancelled));
        assert!(!operation_polled.load(Ordering::SeqCst));
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

    #[test]
    fn legacy_image_without_canonical_ref_still_compiles() {
        let message = LegacyChatMessage {
            role: "user".to_string(),
            content: "legacy".to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64: Some(vec!["legacy-base64".to_string()]),
            doc_attachments: None,
            multimodal_content: None,
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        };
        let images = collect_runtime_images(&[message], 0, &[]);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].base64, "legacy-base64");
    }
}
