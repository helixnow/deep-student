//! Capability-aware ChatV2 context compiler.
//!
//! The database keeps stable typed references. This module is the only place that turns image
//! bytes into request-local payloads and chooses MM -> auxiliary MM -> OCR fallback behavior.
//!
//! Submodules:
//! - [`model_selection`]: generation-model classification, strict/persona resolution, overrides
//! - [`preprocess`]: stage deadlines, compile-strategy decision, cancellable stage runner
//! - [`images`]: image budgeting, runtime-image collection, artifact reuse, payload rewrites
//!
//! This file keeps the `ChatV2Pipeline` orchestration: freezing the execution snapshot and
//! compiling the frozen context for the resolved route.

use super::*;
use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::io::Write;

use crate::llm_manager::{ApiConfig, ImagePayload};

use super::super::types::{CanonicalContentPart, ChatGenerationPlan, ModelExecutionSnapshot};
use crate::vfs::retrieval_planner::{
    plan_generation, ActiveGenerationModel, CapabilitySnapshot, CapabilityState, GenerationRoute,
    QueryModality,
};

mod images;
mod model_selection;
mod preprocess;

pub(crate) use images::{
    select_images_with_budget, ImageBudgetCandidate, DEFAULT_HISTORY_IMAGE_BUDGET,
    DEFAULT_IMAGE_BUDGET,
};

use images::{
    append_observation, append_preview_images, apply_existing_derived_artifacts,
    canonical_content_from_message_metadata, collect_runtime_images,
    override_message_images_with_canonical, retain_selected_images_for_multimodal,
    strip_all_images, CanonicalVfsImage, ResolvedCanonicalImage, ReusedArtifactCoverage,
    RuntimeImage,
};
use model_selection::{
    apply_send_overrides, auxiliary_mm_eligible, canonical_content_for_freeze,
    generation_model_kind, is_dedicated_ocr_candidate, requested_active_model_id,
    requested_generation_model, resolve_strict_requested_model, select_generation_config,
};
use preprocess::{
    context_image_compile_strategy, finalize_visual_observation, run_preprocess_stage,
    ContextImageCompileStrategy, PreprocessStageError, AUXILIARY_MM_STAGE_TIMEOUT,
    OCR_STAGE_TIMEOUT, VISUAL_PREPROCESS_TURN_BUDGET,
};

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
        let strict_requested = resolve_strict_requested_model(
            ctx.options.strict_model_id,
            requested_model_id.as_deref(),
            &all_configs,
            &dedicated_ocr_ids,
        )
        .map_err(ChatV2Error::Llm)?;
        // Ordinary chat overrides may use capability fallback. Persona workers
        // set strict_model_id, in which case the exact enabled config above is
        // the only permissible initially selected model.
        let initially_selected = if let Some(config) = strict_requested.clone() {
            Some(config)
        } else {
            self.llm_manager
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
                .filter(|config| generation_model_kind(config, &dedicated_ocr_ids).is_some())
        };

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
        if let Some(strict) = strict_requested.as_ref() {
            if active.id != strict.id {
                return Err(ChatV2Error::Llm(format!(
                    "Explicit persona model '{}' cannot serve this request; refusing capability fallback to '{}'",
                    strict.id, active.id
                )));
            }
        }
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
                    name: image.name.or_else(|| context_ref.display_name.clone()),
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
                        name: context_ref.display_name.clone(),
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
                        name: Some(format!("{} (page {})", item.name, unit_index + 1)),
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
                                name: Some(item.name.clone()),
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
                        &item.name,
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
                        &item.name,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
