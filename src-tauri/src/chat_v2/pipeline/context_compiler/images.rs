//! Image budgeting and request-local image compilation helpers.
//!
//! Collects runtime images from history + current canonical refs, enforces the image
//! budget deterministically, reuses persisted derived artifacts, and rewrites message
//! payloads for multimodal / text-model request shapes.

use crate::chat_v2::types::CanonicalContentPart;
use crate::models::{ChatMessage as LegacyChatMessage, MultimodalContentPart};
use std::collections::{HashMap, HashSet};

pub(crate) const DEFAULT_IMAGE_BUDGET: usize = 8;
pub(crate) const DEFAULT_HISTORY_IMAGE_BUDGET: usize = 4;

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
pub(super) struct RuntimeImage {
    pub(super) message_index: usize,
    pub(super) image_index: usize,
    pub(super) turn_index: usize,
    pub(super) is_current_turn: bool,
    pub(super) image_id: String,
    pub(super) mime_type: String,
    pub(super) base64: String,
    pub(super) pinned: bool,
    pub(super) retrieval_hit: bool,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedCanonicalImage {
    pub(super) mime_type: String,
    pub(super) base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CanonicalVfsImage {
    pub(super) image_id: String,
    pub(super) name: Option<String>,
    pub(super) source_id: String,
    pub(super) blob_hash: Option<String>,
    pub(super) content_hash: String,
    pub(super) mime_type: String,
}

#[derive(Debug, Default)]
pub(super) struct ReusedArtifactCoverage {
    pub(super) covered_images: HashSet<(usize, usize)>,
    pub(super) used_visual_observation: bool,
    pub(super) used_ocr: bool,
}

pub(super) fn canonical_content_from_message_metadata(
    message: &LegacyChatMessage,
) -> Option<Vec<CanonicalContentPart>> {
    message
        .metadata
        .as_ref()
        .and_then(|value| value.get("canonicalContent"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

pub(super) fn append_preview_images(
    images: &mut Vec<CanonicalVfsImage>,
    seen: &mut HashSet<String>,
    container_resource_id: &str,
    source_id: &str,
    source_name: &str,
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
            name: Some(format!("{} (page {})", source_name, page_index + 1)),
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

pub(super) fn collect_runtime_images(
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

pub(super) fn apply_existing_derived_artifacts(
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

pub(super) fn override_message_images_with_canonical(
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

pub(super) fn retain_selected_images_for_multimodal(
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

pub(super) fn strip_all_images(
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

pub(super) fn append_observation(message: &mut LegacyChatMessage, observation: &str) {
    message.content.push_str(&format!(
        "\n\n<derived_visual_observation>\n{}\n</derived_visual_observation>",
        observation
    ));
}

#[cfg(test)]
mod tests {
    use super::super::preprocess::{context_image_compile_strategy, ContextImageCompileStrategy};
    use super::*;

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
    fn tm_mm_alternating_turns_recompile_the_same_original_image() {
        let canonical = vec![CanonicalContentPart::ImageRef {
            image_id: "img-1".to_string(),
            name: Some("source.png".to_string()),
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
                    name: Some("stable.png".to_string()),
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
