use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::pipeline::context_compiler::{
    compile_ink_visual_message, InkImageError, RetrievalPageImageBudget,
};
use crate::chat_v2::pipeline::helpers::is_transient_skill_message;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{block_status, MessageBlock, ToolResultInfo};
use crate::models::ChatMessage as LegacyChatMessage;
use crate::vfs::database::VfsDatabase;
use dstu_core::agent::InkVisualArtifactRef;

pub(crate) type InkArtifactCallRefs = (String, String, Vec<InkVisualArtifactRef>);

pub(crate) fn validate_ink_artifact_round(
    session_id: &str,
    parent_session_id: &str,
    parent_message_id: &str,
    tool_entries: &[(&MessageBlock, String)],
) -> Result<Option<(String, Vec<InkArtifactCallRefs>)>, InkImageError> {
    let Some((_, round_last_tool_call_id)) = tool_entries.last() else {
        return Ok(None);
    };
    let mut calls = Vec::new();
    for (block, tool_call_id) in tool_entries {
        if block.status != block_status::SUCCESS || block.ink_artifacts.is_empty() {
            continue;
        }
        let Some(tool_name) = block.tool_name.as_deref() else {
            return Err(InkImageError::ImageDeliveryFailed("renderer name missing"));
        };
        if !is_trusted_ink_renderer(tool_name) {
            return Err(InkImageError::ImageDeliveryFailed("untrusted renderer"));
        }
        if parent_session_id != session_id
            || block.message_id != parent_message_id
            || block.status != block_status::SUCCESS
        {
            return Err(InkImageError::ImageDeliveryFailed("parent block mismatch"));
        }
        if block.ink_artifacts.iter().any(|reference| {
            reference.session_id != session_id
                || reference.tool_call_id != *tool_call_id
                || reference.round_last_tool_call_id != *round_last_tool_call_id
        }) {
            return Err(InkImageError::ImageDeliveryFailed("round anchor mismatch"));
        }
        calls.push((
            tool_name.to_string(),
            tool_call_id.clone(),
            block.ink_artifacts.clone(),
        ));
    }
    Ok((!calls.is_empty()).then(|| (round_last_tool_call_id.clone(), calls)))
}

pub(crate) fn is_trusted_ink_renderer(tool_name: &str) -> bool {
    matches!(tool_name, "builtin-ink_render" | "ink_render")
}

pub(crate) fn fail_live_ink_round_results(
    db: &ChatV2Database,
    results: &mut [ToolResultInfo],
    error: &str,
) -> Result<Vec<MessageBlock>, ChatV2Error> {
    let code = if error.contains("VISION_MODEL_REQUIRED") {
        "VISION_MODEL_REQUIRED"
    } else {
        "IMAGE_DELIVERY_FAILED"
    };
    for result in results
        .iter_mut()
        .filter(|result| is_trusted_ink_renderer(&result.tool_name) && result.success)
    {
        result.success = false;
        result.error = Some(error.to_string());
        result.output = serde_json::json!({"code": code, "message": error});
    }

    let conn = db.get_conn_safe()?;
    let mut updated = Vec::new();
    for result in results.iter().filter(|result| {
        is_trusted_ink_renderer(&result.tool_name)
            && !result.success
            && result.error.as_deref() == Some(error)
    }) {
        let Some(block_id) = result.block_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let mut block = ChatV2Repo::get_block_with_conn(&conn, block_id)?.ok_or_else(|| {
            ChatV2Error::Llm(
                "IMAGE_DELIVERY_FAILED: renderer block missing during failure persistence".into(),
            )
        })?;
        block.status = block_status::ERROR.to_string();
        block.error = result.error.clone();
        block.tool_output = Some(result.output.clone());
        ChatV2Repo::update_block_with_conn(&conn, &block)?;
        updated.push(block);
    }
    Ok(updated)
}

fn fail_live_ink_result(
    conn: &rusqlite::Connection,
    result: &mut ToolResultInfo,
    block: Option<&mut MessageBlock>,
    error: &InkImageError,
) -> Result<(), ChatV2Error> {
    let code = match error {
        InkImageError::VisionModelRequired => "VISION_MODEL_REQUIRED",
        InkImageError::ImageDeliveryFailed(_) => "IMAGE_DELIVERY_FAILED",
    };
    let message = error.to_string();
    result.success = false;
    result.error = Some(message.clone());
    result.output = serde_json::json!({"code": code, "message": message});
    if let Some(block) = block {
        block.status = block_status::ERROR.to_string();
        block.error = result.error.clone();
        block.tool_output = Some(result.output.clone());
        ChatV2Repo::update_block_with_conn(conn, block)?;
    }
    Ok(())
}

pub(crate) fn validate_persisted_ink_refs(
    conn: &rusqlite::Connection,
    message_ids: &[String],
) -> Result<(), InkImageError> {
    for chunk in message_ids.chunks(400) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT tool_name, ink_artifacts_json FROM chat_v2_blocks WHERE message_id IN ({placeholders})"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|_| InkImageError::ImageDeliveryFailed("artifact references unavailable"))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(|_| InkImageError::ImageDeliveryFailed("artifact references unavailable"))?;
        for row in rows {
            let (tool_name, refs_json) = row.map_err(|_| {
                InkImageError::ImageDeliveryFailed("artifact references unavailable")
            })?;
            if tool_name.as_deref().is_some_and(is_trusted_ink_renderer) {
                if let Some(raw) = refs_json {
                    serde_json::from_str::<Vec<InkVisualArtifactRef>>(&raw).map_err(|_| {
                        InkImageError::ImageDeliveryFailed("persisted artifact references invalid")
                    })?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn select_recent_ink_visual_rounds(
    vfs_db: &VfsDatabase,
    session_id: &str,
    rounds: &[(String, Vec<InkArtifactCallRefs>)],
    image_limit: usize,
    image_bytes: usize,
    existing_blobs: &std::collections::HashSet<String>,
) -> Result<(Vec<(String, Vec<InkArtifactCallRefs>)>, Vec<String>), InkImageError> {
    use base64::Engine;

    let mut sizes = std::collections::HashMap::new();
    for (round_last_tool_call_id, calls) in rounds {
        for (tool_name, tool_call_id, refs) in calls {
            for reference in refs {
                let mut validation_budget = RetrievalPageImageBudget::new_with_bytes(
                    4,
                    0,
                    0,
                    std::collections::HashSet::new(),
                );
                let message = compile_ink_visual_message(
                    vfs_db,
                    session_id,
                    tool_name,
                    tool_call_id,
                    round_last_tool_call_id,
                    std::slice::from_ref(reference),
                    &mut validation_budget,
                    true,
                )?
                .ok_or(InkImageError::ImageDeliveryFailed(
                    "artifact validation produced no image",
                ))?;
                let encoded = message
                    .multimodal_content
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .find_map(|part| match part {
                        crate::models::MultimodalContentPart::ImageUrl { base64, .. } => {
                            Some(base64)
                        }
                        _ => None,
                    })
                    .ok_or(InkImageError::ImageDeliveryFailed(
                        "artifact validation image missing",
                    ))?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| {
                        InkImageError::ImageDeliveryFailed("artifact PNG decoding failed")
                    })?;
                sizes
                    .entry(reference.blob_hash.clone())
                    .or_insert(bytes.len());
            }
        }
    }

    let mut remaining = image_limit
        .min(crate::chat_v2::pipeline::context_compiler::DEFAULT_HISTORY_IMAGE_BUDGET)
        .min(4);
    let mut remaining_bytes = image_bytes;
    let mut selected = std::collections::HashSet::new();
    for (_, calls) in rounds.iter().rev() {
        for (_, _, refs) in calls.iter().rev() {
            for reference in refs.iter().rev() {
                if existing_blobs.contains(&reference.blob_hash)
                    || selected.contains(&reference.blob_hash)
                    || remaining == 0
                {
                    continue;
                }
                let byte_len = sizes[&reference.blob_hash];
                if byte_len <= remaining_bytes {
                    selected.insert(reference.blob_hash.clone());
                    remaining -= 1;
                    remaining_bytes -= byte_len;
                }
            }
        }
    }

    let mut kept_rounds = Vec::new();
    let mut omitted_rounds = Vec::new();
    for (round_last_tool_call_id, calls) in rounds {
        let mut kept_calls = Vec::new();
        let mut budget_omitted = false;
        for (tool_name, tool_call_id, refs) in calls {
            let mut kept_refs = Vec::new();
            for reference in refs {
                if existing_blobs.contains(&reference.blob_hash) {
                    continue;
                }
                if selected.contains(&reference.blob_hash) {
                    kept_refs.push(reference.clone());
                } else {
                    budget_omitted = true;
                }
            }
            if !kept_refs.is_empty() {
                kept_calls.push((tool_name.clone(), tool_call_id.clone(), kept_refs));
            }
        }
        if !kept_calls.is_empty() {
            kept_rounds.push((round_last_tool_call_id.clone(), kept_calls));
        } else if budget_omitted {
            omitted_rounds.push(round_last_tool_call_id.clone());
        }
    }
    Ok((kept_rounds, omitted_rounds))
}

pub(crate) fn ink_visual_not_included_message() -> LegacyChatMessage {
    let mut message = super::helpers::make_empty_message(
        "user",
        "[Ink render image omitted from this request because the historical image budget was exhausted; it was not delivered to this model.]".to_string(),
    );
    message.metadata = Some(serde_json::json!({
        "kind": "ink_visual_artifacts_unavailable",
        "hidden": true,
    }));
    message
}

pub(crate) fn compile_ink_visual_round(
    vfs_db: &VfsDatabase,
    session_id: &str,
    round_last_tool_call_id: &str,
    calls: &[InkArtifactCallRefs],
    budget: &mut RetrievalPageImageBudget,
    is_multimodal: bool,
) -> Result<Option<LegacyChatMessage>, InkImageError> {
    let mut staged_budget = budget.clone();
    let mut combined: Option<LegacyChatMessage> = None;
    for (tool_name, tool_call_id, refs) in calls {
        if !is_trusted_ink_renderer(tool_name) {
            return Err(InkImageError::ImageDeliveryFailed("untrusted renderer"));
        }
        let Some(message) = compile_ink_visual_message(
            vfs_db,
            session_id,
            tool_name,
            tool_call_id,
            round_last_tool_call_id,
            refs,
            &mut staged_budget,
            is_multimodal,
        )?
        else {
            continue;
        };
        if let Some(existing) = combined.as_mut() {
            existing.content.push('\n');
            existing.content.push_str(&message.content);
            existing
                .multimodal_content
                .get_or_insert_with(Vec::new)
                .extend(message.multimodal_content.unwrap_or_default());
        } else {
            combined = Some(message);
        }
    }
    *budget = staged_budget;
    Ok(combined)
}

pub(crate) fn prepare_live_ink_visual_round(
    db: &ChatV2Database,
    vfs_db: Option<&VfsDatabase>,
    session_id: &str,
    message_id: &str,
    results: &mut [ToolResultInfo],
    budget: &mut RetrievalPageImageBudget,
    is_multimodal: bool,
) -> Result<Option<(String, LegacyChatMessage)>, ChatV2Error> {
    let conn = db.get_conn_safe()?;
    let mut tool_entries = Vec::new();
    for result in results.iter_mut() {
        if !is_trusted_ink_renderer(&result.tool_name) || !result.success {
            continue;
        }
        let Some(call_id) = result
            .tool_call_id
            .as_deref()
            .filter(|call_id| !call_id.is_empty())
        else {
            let error = InkImageError::ImageDeliveryFailed("renderer tool call id missing");
            fail_live_ink_result(&conn, result, None, &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        };
        let Some(block_id) = result.block_id.as_deref().filter(|id| !id.is_empty()) else {
            let error = InkImageError::ImageDeliveryFailed("renderer block id missing");
            fail_live_ink_result(&conn, result, None, &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        };
        let Some(mut block) = ChatV2Repo::get_block_with_conn(&conn, block_id)? else {
            let error = InkImageError::ImageDeliveryFailed("renderer block missing");
            fail_live_ink_result(&conn, result, None, &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        };
        let parent = ChatV2Repo::get_message_with_conn(&conn, &block.message_id)?;
        let Some(parent) = parent else {
            let error = InkImageError::ImageDeliveryFailed("renderer parent missing");
            fail_live_ink_result(&conn, result, Some(&mut block), &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        };
        if block.message_id != message_id
            || parent.session_id != session_id
            || block.tool_name.as_deref() != Some(result.tool_name.as_str())
            || block.status != block_status::SUCCESS
        {
            let error = InkImageError::ImageDeliveryFailed("renderer parent mismatch");
            fail_live_ink_result(&conn, result, Some(&mut block), &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        }
        if block.ink_artifacts.is_empty() {
            let error = InkImageError::ImageDeliveryFailed("trusted renderer refs missing");
            fail_live_ink_result(&conn, result, Some(&mut block), &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        }
        if block.ink_artifacts.iter().any(|reference| {
            reference.session_id != session_id || reference.tool_call_id != call_id
        }) {
            let error = InkImageError::ImageDeliveryFailed("renderer parent identity mismatch");
            fail_live_ink_result(&conn, result, Some(&mut block), &error)?;
            return Err(ChatV2Error::Llm(error.to_string()));
        }
        tool_entries.push((block, call_id.to_string()));
    }
    let Some(round_last_tool_call_id) = results
        .last()
        .and_then(|result| result.tool_call_id.as_deref())
        .filter(|call_id| !call_id.is_empty())
        .map(str::to_string)
    else {
        return Ok(None);
    };
    let mut calls = Vec::new();
    for (block, call_id) in &mut tool_entries {
        if block.ink_artifacts.iter().any(|reference| {
            reference.round_last_tool_call_id != *call_id
                && reference.round_last_tool_call_id != round_last_tool_call_id
        }) {
            let error = InkImageError::ImageDeliveryFailed("renderer round anchor mismatch");
            if let Some(result) = results
                .iter_mut()
                .find(|result| result.tool_call_id.as_deref() == Some(call_id.as_str()))
            {
                fail_live_ink_result(&conn, result, Some(block), &error)?;
            }
            return Err(ChatV2Error::Llm(error.to_string()));
        }
        for reference in &mut block.ink_artifacts {
            reference.round_last_tool_call_id = round_last_tool_call_id.clone();
        }
        calls.push((
            block.tool_name.clone().unwrap_or_default(),
            call_id.clone(),
            block.ink_artifacts.clone(),
            block.clone(),
        ));
    }
    if calls.is_empty() {
        return Ok(None);
    }

    let vfs_db = vfs_db
        .ok_or_else(|| ChatV2Error::Llm("IMAGE_DELIVERY_FAILED: VFS unavailable".to_string()))?;
    let compile_calls: Vec<_> = calls
        .iter()
        .map(|(tool_name, call_id, refs, _)| (tool_name.clone(), call_id.clone(), refs.clone()))
        .collect();
    let image_message = compile_ink_visual_round(
        vfs_db,
        session_id,
        &round_last_tool_call_id,
        &compile_calls,
        budget,
        is_multimodal,
    )
    .map_err(|error| ChatV2Error::Llm(error.to_string()))?;

    for (_, call_id, _, mut block) in calls {
        block.ink_artifacts.iter_mut().for_each(|reference| {
            reference.round_last_tool_call_id = round_last_tool_call_id.clone()
        });
        ChatV2Repo::update_block_with_conn(&conn, &block)?;
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            &block.id,
            &crate::chat_v2::repo::BlockReplayData {
                tool_call_id: Some(call_id),
                ..Default::default()
            },
        )?;
    }
    Ok(image_message.map(|message| (round_last_tool_call_id, message)))
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    fn artifact_ref(blob_hash: &str) -> InkVisualArtifactRef {
        InkVisualArtifactRef {
            artifact_id: format!("artifact-{blob_hash}"),
            render_id: format!("render-{blob_hash}"),
            session_id: "session".into(),
            tool_call_id: format!("call-{blob_hash}"),
            round_last_tool_call_id: format!("call-{blob_hash}"),
            document_id: "doc".into(),
            page_id: "page".into(),
            revision: "revision".into(),
            blob_hash: blob_hash.into(),
            resource_id: format!("resource-{blob_hash}"),
            content_hash: format!("content-{blob_hash}"),
            mime_type: "image/png".into(),
            width_px: 1,
            height_px: 1,
        }
    }

    #[test]
    fn later_invalid_call_does_not_consume_earlier_round_image_budget() {
        use crate::vfs::{
            database::setup_migrated_test_db,
            ink::InkRect,
            repos::{InkArtifactDraft, VfsInkArtifactRepo},
        };

        const PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        let (_dir, db) = setup_migrated_test_db();
        let artifact = VfsInkArtifactRepo::store_png_with_conn(
            &db.get_conn_safe().unwrap(),
            db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: "atomic-render".into(),
                render_id: "atomic-render".into(),
                document_id: "atomic-doc".into(),
                page_id: "atomic-page".into(),
                revision: "revision".into(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: Some(InkRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                }),
                width_px: 1,
                height_px: 1,
            },
            PNG,
        )
        .unwrap();
        let reference = InkVisualArtifactRef {
            artifact_id: artifact.artifact_id,
            render_id: artifact.render_id,
            session_id: "session".into(),
            tool_call_id: "call-first".into(),
            round_last_tool_call_id: "call-last".into(),
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
        let mut invalid = reference.clone();
        invalid.tool_call_id = "call-second".into();
        invalid.document_id.push_str("-forged");
        let mut budget = RetrievalPageImageBudget::new_with_bytes(4, 0, 0, Default::default());
        let before = (budget.remaining(), budget.remaining_bytes());

        assert!(compile_ink_visual_round(
            &db,
            "session",
            "call-last",
            &[
                (
                    "builtin-ink_render".into(),
                    "call-first".into(),
                    vec![reference]
                ),
                (
                    "builtin-ink_render".into(),
                    "call-second".into(),
                    vec![invalid]
                ),
            ],
            &mut budget,
            true,
        )
        .is_err());
        assert_eq!((budget.remaining(), budget.remaining_bytes()), before);
    }

    #[test]
    fn live_failure_is_structured_even_when_persisting_error_block_fails() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut result = ToolResultInfo::success(
            Some("call-ink".into()),
            Some("missing-block".into()),
            "builtin-ink_render".into(),
            serde_json::json!({}),
            serde_json::json!({"ok": true}),
            1,
        );
        let mut block = MessageBlock::new_tool(
            "assistant".into(),
            "builtin-ink_render",
            serde_json::json!({}),
            0,
        );
        let error = InkImageError::ImageDeliveryFailed("artifact unavailable");

        assert!(fail_live_ink_result(&conn, &mut result, Some(&mut block), &error).is_err());
        assert!(
            !result.success,
            "delivery must fail even when its DB update fails"
        );
        assert_eq!(result.output["code"], "IMAGE_DELIVERY_FAILED");
        assert_eq!(block.status, block_status::ERROR);
    }

    #[test]
    fn missing_round_tail_is_reported_as_not_inserted() {
        let mut messages = vec![super::super::helpers::make_empty_message(
            "assistant",
            "parallel calls".into(),
        )];
        let image = super::compile_ink_visual_round;
        let _ = image;
        let inserted = insert_ink_visual_message_after_tool_result(
            &mut messages,
            "call-tail-missing",
            super::ink_visual_not_included_message(),
        );
        assert!(!inserted);
        assert_eq!(messages.len(), 1);
    }
}

pub(crate) fn insert_ink_visual_message_after_tool_result(
    messages: &mut Vec<LegacyChatMessage>,
    round_last_tool_call_id: &str,
    message: LegacyChatMessage,
) -> bool {
    let Some(mut insert_at) = messages
        .iter()
        .rposition(|message| {
            message
                .tool_result
                .as_ref()
                .is_some_and(|result| result.call_id == round_last_tool_call_id)
        })
        .map(|position| position + 1)
    else {
        return false;
    };
    while messages.get(insert_at).is_some_and(|message| {
        is_transient_skill_message(message)
            || message.metadata.as_ref().is_some_and(|metadata| {
                matches!(
                    metadata.get("kind").and_then(serde_json::Value::as_str),
                    Some("retrieval_page_images" | "ink_visual_artifacts")
                )
            })
    }) {
        insert_at += 1;
    }
    messages.insert(insert_at, message);
    true
}
