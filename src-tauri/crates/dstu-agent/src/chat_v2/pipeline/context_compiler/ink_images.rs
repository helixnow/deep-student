use crate::chat_v2::pipeline::context_compiler::RetrievalPageImageBudget;
use crate::models::{ChatMessage as LegacyChatMessage, MultimodalContentPart};
use crate::vfs::{database::VfsDatabase, repos::VfsInkArtifactRepo};
use base64::Engine;
use dstu_core::agent::InkVisualArtifactRef;
use serde_json::json;
use std::collections::HashSet;

const MAX_INK_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_INK_IMAGE_EDGE: u32 = 2048;

#[derive(Debug, thiserror::Error)]
pub(crate) enum InkImageError {
    #[error("VISION_MODEL_REQUIRED")]
    VisionModelRequired,
    #[error("IMAGE_DELIVERY_FAILED: {0}")]
    ImageDeliveryFailed(&'static str),
}

struct ResolvedInkImage {
    reference: InkVisualArtifactRef,
    bytes: Vec<u8>,
}

pub(crate) fn compile_ink_visual_message(
    vfs_db: &VfsDatabase,
    session_id: &str,
    tool_name: &str,
    tool_call_id: &str,
    round_last_tool_call_id: &str,
    refs: &[InkVisualArtifactRef],
    budget: &mut RetrievalPageImageBudget,
    is_multimodal: bool,
) -> Result<Option<LegacyChatMessage>, InkImageError> {
    if !is_multimodal {
        return Err(InkImageError::VisionModelRequired);
    }
    if refs.is_empty() {
        return Ok(None);
    }
    if !matches!(tool_name, "builtin-ink_render" | "ink_render") {
        return Err(InkImageError::ImageDeliveryFailed("untrusted renderer"));
    }

    let conn = vfs_db
        .get_conn_safe()
        .map_err(|_| InkImageError::ImageDeliveryFailed("VFS unavailable"))?;
    let mut resolved = Vec::with_capacity(refs.len());
    for reference in refs {
        if reference.session_id != session_id
            || reference.tool_call_id != tool_call_id
            || reference.round_last_tool_call_id != round_last_tool_call_id
        {
            return Err(InkImageError::ImageDeliveryFailed(
                "parent identity mismatch",
            ));
        }
        let (artifact, bytes) =
            VfsInkArtifactRepo::load_with_conn(&conn, vfs_db.blobs_dir(), &reference.render_id)
                .map_err(|_| {
                    InkImageError::ImageDeliveryFailed("artifact unavailable or invalid")
                })?;
        if artifact.artifact_id != reference.artifact_id
            || artifact.render_id != reference.render_id
            || artifact.document_id != reference.document_id
            || artifact.page_id != reference.page_id
            || artifact.revision != reference.revision
            || artifact.blob_hash != reference.blob_hash
            || artifact.resource_id != reference.resource_id
            || artifact.content_hash != reference.content_hash
            || artifact.mime_type != reference.mime_type
            || artifact.width_px != reference.width_px
            || artifact.height_px != reference.height_px
            || reference.mime_type != "image/png"
            || reference.width_px == 0
            || reference.height_px == 0
            || reference.width_px.max(reference.height_px) > MAX_INK_IMAGE_EDGE
            || bytes.len() > MAX_INK_IMAGE_BYTES
        {
            return Err(InkImageError::ImageDeliveryFailed(
                "artifact provenance mismatch",
            ));
        }
        resolved.push(ResolvedInkImage {
            reference: reference.clone(),
            bytes,
        });
    }

    // Validate the complete reference batch before changing shared request budget.
    let mut fresh = Vec::new();
    let mut fresh_hashes = HashSet::new();
    for image in resolved {
        if !budget.contains_blob(&image.reference.blob_hash)
            && fresh_hashes.insert(image.reference.blob_hash.clone())
        {
            fresh.push(image);
        }
    }
    if fresh.is_empty() {
        return Ok(None);
    }
    if budget.remaining() == 0 {
        return Err(InkImageError::ImageDeliveryFailed(
            "image count budget exhausted",
        ));
    }

    let selected_bytes = fresh.iter().map(|image| image.bytes.len()).sum::<usize>();
    if fresh.len() > budget.remaining() {
        return Err(InkImageError::ImageDeliveryFailed(
            "image count budget exhausted",
        ));
    }
    if selected_bytes > budget.remaining_bytes() {
        return Err(InkImageError::ImageDeliveryFailed(
            "image byte budget exhausted",
        ));
    }
    let selected = fresh;
    let commits: Vec<_> = selected
        .iter()
        .map(|image| (image.reference.blob_hash.as_str(), image.bytes.len()))
        .collect();
    if !budget.commit_batch_with_bytes(&commits) {
        return Err(InkImageError::ImageDeliveryFailed("image budget exhausted"));
    }

    let labels = selected
        .iter()
        .map(|image| {
            format!(
                "[Ink render] document {}, page {}, revision {}",
                image.reference.document_id, image.reference.page_id, image.reference.revision
            )
        })
        .collect::<Vec<_>>();
    let body = labels.join("\n");
    let mut parts = vec![MultimodalContentPart::text(body.clone())];
    for (image, label) in selected.iter().zip(labels) {
        parts.push(MultimodalContentPart::text(label));
        parts.push(MultimodalContentPart::image(
            image.reference.mime_type.clone(),
            base64::engine::general_purpose::STANDARD.encode(&image.bytes),
        ));
    }
    let mut message = super::super::helpers::make_empty_message("user", body);
    message.multimodal_content = Some(parts);
    message.metadata = Some(json!({"kind": "ink_visual_artifacts", "hidden": true}));
    Ok(Some(message))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::models::MultimodalContentPart;
    use crate::vfs::{
        database::{setup_migrated_test_db, VfsDatabase},
        ink::InkRect,
        repos::{InkArtifactDraft, VfsBlobRepo, VfsInkArtifactRepo},
    };
    use base64::Engine;

    use super::compile_ink_visual_message;
    use crate::chat_v2::pipeline::context_compiler::RetrievalPageImageBudget;

    type ArtifactRef = dstu_core::agent::InkVisualArtifactRef;

    fn artifact_fixture() -> (tempfile::TempDir, VfsDatabase, ArtifactRef) {
        let (temp_dir, db) = setup_migrated_test_db();
        let artifact = {
            let conn = db.get_conn_safe().unwrap();
            VfsInkArtifactRepo::store_png_with_conn(
                &conn,
                db.blobs_dir(),
                InkArtifactDraft {
                    artifact_id: "render-ink-positive".to_string(),
                    render_id: "render-ink-positive".to_string(),
                    document_id: "doc-ink-positive".to_string(),
                    page_id: "page-1".to_string(),
                    revision: "revision-1".to_string(),
                    source_hash: None,
                    source_annotation_revision: None,
                    conversion_revision: None,
                    crop: Some(InkRect {
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 100.0,
                    }),
                    width_px: 1,
                    height_px: 1,
                },
                PNG_1X1,
            )
            .unwrap()
        };
        let reference = ArtifactRef {
            artifact_id: artifact.artifact_id,
            render_id: artifact.render_id,
            session_id: "session-ink-positive".to_string(),
            tool_call_id: "call-ink-positive".to_string(),
            round_last_tool_call_id: "call-ink-positive".to_string(),
            document_id: artifact.document_id,
            page_id: artifact.page_id,
            revision: artifact.revision,
            blob_hash: artifact.blob_hash,
            resource_id: artifact.resource_id,
            content_hash: artifact.content_hash,
            mime_type: artifact.mime_type,
            width_px: artifact.width_px,
            height_px: artifact.height_px,
        };
        (temp_dir, db, reference)
    }

    fn compile(
        db: &VfsDatabase,
        refs: &[ArtifactRef],
        budget: &mut RetrievalPageImageBudget,
        session_id: &str,
        tool_name: &str,
        tool_call_id: &str,
        round_last_tool_call_id: &str,
        is_multimodal: bool,
    ) -> Result<Option<crate::models::ChatMessage>, super::InkImageError> {
        compile_ink_visual_message(
            db,
            session_id,
            tool_name,
            tool_call_id,
            round_last_tool_call_id,
            refs,
            budget,
            is_multimodal,
        )
    }

    fn assert_ref_rejected(
        db: &VfsDatabase,
        original: &ArtifactRef,
        mutate: impl FnOnce(&mut ArtifactRef),
    ) {
        let mut reference = original.clone();
        mutate(&mut reference);
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        assert!(matches!(
            compile(
                db,
                &[reference],
                &mut budget,
                "session-ink-positive",
                "builtin-ink_render",
                "call-ink-positive",
                "call-ink-positive",
                true,
            ),
            Err(super::InkImageError::ImageDeliveryFailed(_))
        ));
        assert_eq!(budget.remaining(), 4);
        assert_eq!(budget.remaining_bytes(), 16 * 1024 * 1024);
    }

    fn assert_context_rejected(
        db: &VfsDatabase,
        reference: &ArtifactRef,
        session_id: &str,
        tool_name: &str,
        tool_call_id: &str,
        round_last_tool_call_id: &str,
    ) {
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        assert!(matches!(
            compile(
                db,
                std::slice::from_ref(reference),
                &mut budget,
                session_id,
                tool_name,
                tool_call_id,
                round_last_tool_call_id,
                true,
            ),
            Err(super::InkImageError::ImageDeliveryFailed(_))
        ));
        assert_eq!(budget.remaining(), 4);
        assert_eq!(budget.remaining_bytes(), 16 * 1024 * 1024);
    }

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn migrated_ink_artifact_compiles_to_labeled_user_image_with_original_png_bytes() {
        let (_temp_dir, db, artifact_ref) = artifact_fixture();
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());

        let message = compile_ink_visual_message(
            &db,
            "session-ink-positive",
            "builtin-ink_render",
            "call-ink-positive",
            "call-ink-positive",
            &[artifact_ref],
            &mut budget,
            true,
        )
        .unwrap()
        .expect("valid ink artifact should produce an image message");

        assert_eq!(message.role, "user");
        let parts = message
            .multimodal_content
            .expect("multimodal image message");
        assert!(parts.iter().any(|part| matches!(part,
            MultimodalContentPart::Text { text }
                if text.contains("doc-ink-positive") && text.contains("page-1"))));
        let image = parts
            .iter()
            .find_map(|part| match part {
                MultimodalContentPart::ImageUrl { media_type, base64 } => {
                    Some((media_type, base64))
                }
                _ => None,
            })
            .expect("compiled ink message has an actual image URL part");
        assert_eq!(image.0, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(image.1)
                .unwrap(),
            PNG_1X1,
        );
    }

    #[test]
    fn rejects_untrusted_parent_and_tool_names_without_budget_use() {
        let (_temp_dir, db, reference) = artifact_fixture();
        for (session, tool, call, round) in [
            (
                "forged-session",
                "builtin-ink_render",
                "call-ink-positive",
                "call-ink-positive",
            ),
            (
                "session-ink-positive",
                "builtin-ink_render",
                "forged-call",
                "call-ink-positive",
            ),
            (
                "session-ink-positive",
                "builtin-ink_render",
                "call-ink-positive",
                "forged-round",
            ),
            (
                "session-ink-positive",
                "mcp-ink_render",
                "call-ink-positive",
                "call-ink-positive",
            ),
        ] {
            assert_context_rejected(&db, &reference, session, tool, call, round);
        }
    }

    #[test]
    fn rejects_each_mismatched_artifact_reference_field_without_budget_use() {
        let (_temp_dir, db, reference) = artifact_fixture();
        assert_ref_rejected(&db, &reference, |r| r.blob_hash.push('a'));
        assert_ref_rejected(&db, &reference, |r| r.width_px += 1);
        assert_ref_rejected(&db, &reference, |r| r.height_px += 1);
        assert_ref_rejected(&db, &reference, |r| r.document_id.push_str("-other"));
        assert_ref_rejected(&db, &reference, |r| r.revision.push_str("-other"));
        assert_ref_rejected(&db, &reference, |r| r.mime_type = "image/jpeg".to_string());
        assert_ref_rejected(&db, &reference, |r| r.resource_id.push_str("-other"));
        assert_ref_rejected(&db, &reference, |r| r.content_hash.push('a'));
        assert_ref_rejected(&db, &reference, |r| r.artifact_id.push_str("-other"));
        assert_ref_rejected(&db, &reference, |r| r.session_id.push_str("-forged"));
        assert_ref_rejected(&db, &reference, |r| r.tool_call_id.push_str("-forged"));
        assert_ref_rejected(&db, &reference, |r| {
            r.round_last_tool_call_id.push_str("-forged")
        });
    }

    #[test]
    fn rejects_missing_artifact_and_missing_published_blob_bytes() {
        let (_temp_dir, db, reference) = artifact_fixture();
        let mut missing_artifact = reference.clone();
        missing_artifact.render_id = "missing-render".to_string();
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        assert!(matches!(
            compile(
                &db,
                &[missing_artifact],
                &mut budget,
                "session-ink-positive",
                "builtin-ink_render",
                "call-ink-positive",
                "call-ink-positive",
                true,
            ),
            Err(super::InkImageError::ImageDeliveryFailed(_))
        ));
        assert_eq!(budget.remaining(), 4);

        let blob_path = {
            let conn = db.get_conn_safe().unwrap();
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &reference.blob_hash)
                .unwrap()
                .unwrap()
        };
        std::fs::remove_file(blob_path).unwrap();
        assert_ref_rejected(&db, &reference, |_| {});
    }

    #[test]
    fn nonvision_gate_precedes_empty_reference_noop() {
        let (_temp_dir, db, _reference) = artifact_fixture();
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        assert!(matches!(
            compile(
                &db,
                &[],
                &mut budget,
                "session-ink-positive",
                "builtin-ink_render",
                "call-ink-positive",
                "call-ink-positive",
                false
            ),
            Err(super::InkImageError::VisionModelRequired)
        ));
        assert_eq!(budget.remaining(), 4);
    }

    #[test]
    fn duplicate_blob_refs_deliver_once_and_charge_shared_budget_once() {
        let (_temp_dir, db, reference) = artifact_fixture();
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        let message = compile(
            &db,
            &[reference.clone(), reference.clone()],
            &mut budget,
            "session-ink-positive",
            "builtin-ink_render",
            "call-ink-positive",
            "call-ink-positive",
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            message
                .multimodal_content
                .unwrap()
                .iter()
                .filter(|part| matches!(part, MultimodalContentPart::ImageUrl { .. }))
                .count(),
            1
        );
        assert_eq!(budget.remaining(), 3);
        assert_eq!(budget.remaining_bytes(), 16 * 1024 * 1024 - PNG_1X1.len());
    }

    #[test]
    fn invalid_member_and_budget_exhaustion_leave_batch_budget_unchanged() {
        let (_temp_dir, db, reference) = artifact_fixture();
        let mut invalid = reference.clone();
        invalid.revision.push_str("-forged");
        let mut budget = RetrievalPageImageBudget::new(8, 0, HashSet::new());
        assert!(compile(
            &db,
            &[reference.clone(), invalid],
            &mut budget,
            "session-ink-positive",
            "builtin-ink_render",
            "call-ink-positive",
            "call-ink-positive",
            true,
        )
        .is_err());
        assert_eq!(budget.remaining(), 4);
        assert_eq!(budget.remaining_bytes(), 16 * 1024 * 1024);

        let mut no_slots = RetrievalPageImageBudget::new(4, 4, HashSet::new());
        assert!(compile(
            &db,
            std::slice::from_ref(&reference),
            &mut no_slots,
            "session-ink-positive",
            "builtin-ink_render",
            "call-ink-positive",
            "call-ink-positive",
            true,
        )
        .is_err());
        assert_eq!(no_slots.remaining(), 0);
        assert_eq!(no_slots.remaining_bytes(), 16 * 1024 * 1024);

        let mut no_bytes =
            RetrievalPageImageBudget::new_with_bytes(8, 0, 16 * 1024 * 1024, HashSet::new());
        assert!(compile(
            &db,
            &[reference],
            &mut no_bytes,
            "session-ink-positive",
            "builtin-ink_render",
            "call-ink-positive",
            "call-ink-positive",
            true,
        )
        .is_err());
        assert_eq!(no_bytes.remaining(), 4);
        assert_eq!(no_bytes.remaining_bytes(), 0);
    }
}
