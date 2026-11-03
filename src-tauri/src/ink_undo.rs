//! Windowless service boundary and Tauri command for undoing trusted Ink tool operations.

use std::{collections::HashSet, sync::Arc};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const INK_UNDO_MAX_BYTES: usize = 16 * 1024 * 1024;
const INK_UNDO_SCHEMA_VERSION: u32 = 1;
const INK_APPLY_TOOL: &str = "builtin-ink_apply_ops";
const TOOL_OPERATION_PREFIX: &str = "deepstudent.ink.tool-operation.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InkUndoResult {
    pub document_id: String,
    pub revision: String,
    pub operation_id: String,
    pub affected_page_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InkUndoError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl InkUndoError {
    fn new(code: &str, message: &str, retryable: bool) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            retryable,
        }
    }

    fn unknown() -> Self {
        Self::new(
            "OPERATION_STATE_UNKNOWN",
            "The Ink operation result cannot be verified; reload the document before retrying.",
            false,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredApplyInput {
    document_id: String,
    expected_revision: String,
    operation_id: String,
    ops: Vec<serde_json::Value>,
}

struct TrustedUndoSource {
    receipt: crate::chat_v2::tools::ink_executor::InkUndoReceipt,
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= 128
        && !value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
}

fn valid_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn scoped_tool_operation_id(session_id: &str, tool: &str, client_operation_id: &str) -> String {
    let input = format!("{TOOL_OPERATION_PREFIX}\0{session_id}\0{tool}\0{client_operation_id}");
    format!("agent-{}", hex::encode(Sha256::digest(input.as_bytes())))
}

fn invalid_receipt() -> InkUndoError {
    InkUndoError::new(
        "INVALID_RECEIPT",
        "The stored Ink undo receipt is invalid.",
        false,
    )
}

fn load_trusted_source(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    message_id: &str,
    block_id: &str,
) -> Result<TrustedUndoSource, InkUndoError> {
    let conn = chat_db
        .get_conn_safe()
        .map_err(|_| InkUndoError::new("INTERNAL", "Chat storage is unavailable.", true))?;
    let row: Option<(String, String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>)> = conn.query_row(
        "SELECT m.role, m.block_ids_json, b.block_type, b.status, COALESCE(b.tool_name, ''), b.tool_input_json, b.ink_undo_json, b.tool_call_id, b.tool_output_json FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id = b.message_id WHERE b.id = ?1 AND b.message_id = ?2 AND m.session_id = ?3",
        rusqlite::params![block_id, message_id, session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
    ).optional().map_err(|_| InkUndoError::new("INTERNAL", "Chat storage is unavailable.", true))?;
    let Some((
        role,
        block_ids_json,
        block_type,
        status,
        tool_name,
        tool_input_json,
        raw_receipt,
        replay_tool_call_id,
        raw_tool_output,
    )) = row
    else {
        return Err(InkUndoError::unknown());
    };
    if role != "assistant"
        || block_type != crate::chat_v2::types::block_types::MCP_TOOL
        || status != crate::chat_v2::types::block_status::SUCCESS
        || tool_name != INK_APPLY_TOOL
    {
        return Err(InkUndoError::unknown());
    }
    let block_ids: Vec<String> =
        serde_json::from_str(&block_ids_json).map_err(|_| InkUndoError::unknown())?;
    if !block_ids.iter().any(|id| id == block_id) {
        return Err(InkUndoError::unknown());
    }
    let replay_tool_call_id = replay_tool_call_id
        .filter(|id| valid_id(id))
        .ok_or_else(InkUndoError::unknown)?;
    let raw_receipt = raw_receipt.ok_or_else(InkUndoError::unknown)?;
    if raw_receipt.len() > INK_UNDO_MAX_BYTES {
        return Err(invalid_receipt());
    }
    let receipt: crate::chat_v2::tools::ink_executor::InkUndoReceipt =
        serde_json::from_str(&raw_receipt).map_err(|_| invalid_receipt())?;
    let input_json = tool_input_json.ok_or_else(InkUndoError::unknown)?;
    if input_json.len() > INK_UNDO_MAX_BYTES {
        return Err(invalid_receipt());
    }
    let input: StoredApplyInput =
        serde_json::from_str(&input_json).map_err(|_| InkUndoError::unknown())?;
    if receipt.schema_version != INK_UNDO_SCHEMA_VERSION
        || receipt.session_id != session_id
        || receipt.message_id != message_id
        || receipt.block_id != block_id
        || receipt.tool_call_id != replay_tool_call_id
        || !valid_id(&receipt.tool_call_id)
        || !valid_id(&receipt.document_id)
        || !valid_id(&receipt.operation_id)
        || !valid_hex64(&receipt.input_hash)
        || !valid_hex64(&receipt.vfs_input_hash)
        || receipt.created_at < 0
        || !valid_id(&receipt.previous_revision)
        || receipt
            .result_revision
            .as_deref()
            .is_some_and(|revision| !valid_id(revision))
        || (receipt.committed && receipt.result_revision.is_none())
        || receipt.document_id != input.document_id
        || receipt.previous_revision != input.expected_revision
        || !valid_id(&input.document_id)
        || !valid_id(&input.expected_revision)
        || !valid_id(&input.operation_id)
        || receipt.operation_id
            != scoped_tool_operation_id(session_id, "apply_ops", &input.operation_id)
        || !(1..=100).contains(&input.ops.len())
    {
        return Err(invalid_receipt());
    }
    let public_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            input.document_id.as_str(),
            input.expected_revision.as_str(),
            &input.ops,
        ))
        .map_err(|_| invalid_receipt())?,
    ));
    if receipt.input_hash != public_hash {
        return Err(invalid_receipt());
    }
    if receipt.committed {
        let output: serde_json::Value = raw_tool_output
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .ok_or_else(|| InkUndoError::unknown())?;
        if output.get("status").and_then(serde_json::Value::as_str) != Some("committed")
            || output
                .get("document_id")
                .and_then(serde_json::Value::as_str)
                != Some(receipt.document_id.as_str())
            || output
                .get("operation_id")
                .and_then(serde_json::Value::as_str)
                != Some(receipt.operation_id.as_str())
            || output.get("revision").and_then(serde_json::Value::as_str)
                != receipt.result_revision.as_deref()
        {
            return Err(InkUndoError::unknown());
        }
    }
    let mut seen_changes = HashSet::new();
    for change in &receipt.object_changes {
        if !valid_id(&change.page_id)
            || !valid_id(&change.object_id)
            || (change.before.is_none() && change.after.is_none())
            || change
                .before
                .as_ref()
                .is_some_and(|object| object.id != change.object_id)
            || change
                .after
                .as_ref()
                .is_some_and(|object| object.id != change.object_id)
            || !seen_changes.insert((change.page_id.as_str(), change.object_id.as_str()))
        {
            return Err(invalid_receipt());
        }
    }
    let mut seen_pages = HashSet::new();
    if receipt
        .appended_page_ids
        .iter()
        .any(|page_id| !valid_id(page_id) || !seen_pages.insert(page_id.as_str()))
        || (receipt.object_changes.is_empty() && receipt.appended_page_ids.is_empty())
    {
        return Err(invalid_receipt());
    }
    Ok(TrustedUndoSource { receipt })
}

/// Windowless service used by the command and real-database tests.
pub fn undo_ink_operation(
    vfs_db: &crate::vfs::VfsDatabase,
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    message_id: &str,
    block_id: &str,
    expected_revision: &str,
    operation_id: &str,
) -> Result<InkUndoResult, InkUndoError> {
    if !valid_id(session_id)
        || !valid_id(message_id)
        || !valid_id(block_id)
        || !valid_id(expected_revision)
        || !valid_id(operation_id)
    {
        return Err(InkUndoError::new(
            "INVALID_ARGUMENT",
            "Undo identifiers and revision must be valid.",
            false,
        ));
    }
    let source = load_trusted_source(chat_db, session_id, message_id, block_id)?;
    let conn = vfs_db
        .get_conn_safe()
        .map_err(|_| InkUndoError::new("INTERNAL", "VFS storage is unavailable.", true))?;
    let manifest = crate::vfs::repos::VfsInkRepo::get_manifest_with_conn(
        &conn,
        vfs_db.blobs_dir(),
        &source.receipt.document_id,
    )
    .map_err(|_| {
        InkUndoError::new(
            "RESOURCE_NOT_FOUND",
            "The Ink document was not found.",
            false,
        )
    })?;
    let canonical = manifest.last_operation.as_ref();
    let prepared_proven = canonical.is_some_and(|canonical| {
        canonical.operation_id == source.receipt.operation_id
            && canonical.input_hash == source.receipt.vfs_input_hash
            && canonical.result_revision == manifest.revision
            && source
                .receipt
                .result_revision
                .as_deref()
                .is_none_or(|revision| revision == manifest.revision)
    });
    let retry_proven = canonical.is_some_and(|canonical| {
        canonical.operation_id == operation_id
            && canonical.previous_revision.as_deref() == Some(expected_revision)
            && canonical.result_revision == manifest.revision
    });
    if !source.receipt.committed && !prepared_proven && !retry_proven {
        return Err(InkUndoError::unknown());
    }
    if manifest.revision != expected_revision && !retry_proven {
        return Err(InkUndoError::new(
            "REVISION_CONFLICT",
            "The Ink document changed; reload and retry undo.",
            true,
        ));
    }
    let changes = crate::chat_v2::tools::ink_executor::object_changes(&source.receipt);
    let (manifest, result) = crate::vfs::repos::VfsInkOperationRepo::undo_with_conn(
        &conn,
        vfs_db.blobs_dir(),
        &source.receipt.document_id,
        expected_revision,
        operation_id,
        &changes,
        &source.receipt.appended_page_ids,
    )
    .map_err(|error| match error {
        crate::vfs::VfsError::Conflict { key, .. } if key == "ink.revision_conflict" => {
            InkUndoError::new(
                "REVISION_CONFLICT",
                "The Ink document changed; reload and retry undo.",
                true,
            )
        }
        crate::vfs::VfsError::Conflict { key, .. } if key == "ink.operation_id_reused" => {
            InkUndoError::new(
                "INVALID_ARGUMENT",
                "Undo operation ID was reused with different input.",
                false,
            )
        }
        _ => InkUndoError::unknown(),
    })?;
    Ok(InkUndoResult {
        document_id: manifest.document_id,
        revision: manifest.revision,
        operation_id: operation_id.to_owned(),
        affected_page_ids: result.affected_page_ids,
    })
}

#[tauri::command]
pub async fn vfs_ink_undo_tool_operation(
    session_id: String,
    message_id: String,
    block_id: String,
    expected_revision: String,
    operation_id: String,
    app: AppHandle,
    window: WebviewWindow,
    vfs_db: State<'_, Arc<crate::vfs::VfsDatabase>>,
    chat_db: State<'_, Arc<crate::chat_v2::database::ChatV2Database>>,
) -> Result<InkUndoResult, InkUndoError> {
    let main_label = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .map(|config| config.label.as_str());
    if main_label != Some(window.label()) {
        return Err(InkUndoError::new(
            "UNTRUSTED_WEBVIEW",
            "Only the configured main webview may undo Ink operations.",
            false,
        ));
    }
    let vfs_db = Arc::clone(&vfs_db);
    let chat_db = Arc::clone(&chat_db);
    let source_db = chat_db.clone();
    let session_for_source = session_id.clone();
    let message_for_source = message_id.clone();
    let block_for_source = block_id.clone();
    let document_id = tauri::async_runtime::spawn_blocking(move || {
        load_trusted_source(
            &source_db,
            &session_for_source,
            &message_for_source,
            &block_for_source,
        )
        .map(|source| source.receipt.document_id)
    })
    .await
    .map_err(|_| InkUndoError::new("INTERNAL", "Chat storage is unavailable.", true))??;
    crate::ink_bridge::flush_ink_editor(&app, &document_id)
        .await
        .map_err(|error| {
            InkUndoError::new(
                &error.code,
                &error.message,
                error.code == "EDITOR_BUSY" || error.code == "EDITOR_UNAVAILABLE",
            )
        })?;

    let undo_session = session_id.clone();
    let undo_message = message_id.clone();
    let undo_block = block_id.clone();
    let undo_revision = expected_revision.clone();
    let undo_operation = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        undo_ink_operation(
            &vfs_db,
            &chat_db,
            &undo_session,
            &undo_message,
            &undo_block,
            &undo_revision,
            &undo_operation,
        )
    })
    .await
    .map_err(|_| InkUndoError::new("INTERNAL", "Ink storage operation failed.", true))??;
    if let Err(error) = app.emit("ink:changed", &result) {
        tracing::warn!("Failed to emit ink:changed after undo: {error}");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::undo_ink_operation;
    use crate::{
        chat_v2::{
            database::ChatV2Database,
            repo::{BlockReplayData, ChatV2Repo},
            types::{ChatMessage, ChatSession, MessageBlock},
        },
        data_governance::{
            migration::coordinator::MigrationCoordinator, schema_registry::DatabaseId,
        },
        vfs::{
            database::setup_migrated_test_db,
            ink::{
                InkAuthor, InkObject, InkObjectContent, InkOperation, InkRuling, InkSample,
                InkStrokeStyle, InkTool,
            },
            ink_commands::{self, InkCreateRequest},
            repos::{ink_operation_repo::VfsInkOperationRepo, ink_repo::VfsInkRepo},
        },
    };
    use rusqlite::params;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    const SESSION_ID: &str = "undo-session";
    const MESSAGE_ID: &str = "undo-message";
    const BLOCK_ID: &str = "undo-block";
    const AI_CLIENT_OPERATION_ID: &str = "trusted-ai-operation";
    const TOOL_CALL_ID: &str = "trusted-tool-call";
    const UNDO_OPERATION_ID: &str = "new-undo-operation";

    fn scoped_ai_operation_id(session_id: &str) -> String {
        super::scoped_tool_operation_id(session_id, "apply_ops", AI_CLIENT_OPERATION_ID)
    }

    fn migrated_chat_db() -> (TempDir, ChatV2Database) {
        let dir = tempfile::tempdir().expect("Chat V2 temporary directory");
        MigrationCoordinator::new(dir.path().to_path_buf())
            .with_audit_db(None)
            .migrate_single(DatabaseId::ChatV2)
            .expect("migrate Chat V2 test database");
        let db = ChatV2Database::new(dir.path()).expect("open migrated Chat V2 database");
        (dir, db)
    }

    fn seed_receipt(
        chat_db: &ChatV2Database,
        document_id: &str,
        previous_revision: &str,
        result_revision: &str,
        vfs_input_hash: &str,
        appended_page_ids: &[String],
        tool_name: &str,
        committed: bool,
        session_id: &str,
    ) {
        let session = ChatSession::new(session_id.to_owned(), "general_chat".to_owned());
        ChatV2Repo::create_session_v2(chat_db, &session).expect("persist Chat session");
        let mut message = ChatMessage::new_assistant(session_id.to_owned());
        message.id = MESSAGE_ID.to_owned();
        let mut block =
            MessageBlock::new_tool(message.id.clone(), "builtin-ink_apply_ops", json!({}), 0);
        block.id = BLOCK_ID.to_owned();
        block.status = "success".to_owned();
        message.block_ids = vec![BLOCK_ID.to_owned()];
        ChatV2Repo::create_message_v2(chat_db, &message).expect("persist assistant message");
        ChatV2Repo::create_block_v2(chat_db, &block).expect("persist tool block");
        {
            let conn = chat_db.get_conn_safe().expect("Chat replay connection");
            ChatV2Repo::update_block_replay_with_conn(
                &conn,
                BLOCK_ID,
                &BlockReplayData {
                    llm_content: None,
                    tool_call_id: Some(TOOL_CALL_ID.to_owned()),
                    round_text: None,
                },
            )
            .expect("persist provider tool-call identity");
        }

        let tool_input = json!({
            "document_id": document_id,
            "expected_revision": previous_revision,
            "operation_id": AI_CLIENT_OPERATION_ID,
            "ops": [{"op":"append_blank_page", "width":800.0, "height":1000.0, "ruling":"blank"}],
        });
        let input_hash = hex::encode(Sha256::digest(
            serde_json::to_vec(&(document_id, previous_revision, &tool_input["ops"]))
                .expect("serialize public tool input"),
        ));
        let output = if committed {
            json!({
                "status": "committed",
                "document_id": document_id,
                "operation_id": scoped_ai_operation_id(session_id),
                "revision": result_revision,
                "affected_page_ids": appended_page_ids,
                "undo_available": true,
            })
        } else {
            json!({"status": "prepared"})
        };
        let receipt = json!({
            "schema_version": 1,
            "session_id": session_id,
            "message_id": MESSAGE_ID,
            "block_id": BLOCK_ID,
            "tool_call_id": TOOL_CALL_ID,
            "document_id": document_id,
            "operation_id": scoped_ai_operation_id(session_id),
            "input_hash": input_hash,
            "created_at": 1,
            "previous_revision": previous_revision,
            "result_revision": result_revision,
            "vfs_input_hash": vfs_input_hash,
            "object_changes": [],
            "appended_page_ids": appended_page_ids,
            "committed": committed,
        });
        let conn = chat_db.get_conn_safe().expect("Chat connection");
        conn.execute(
            "UPDATE chat_v2_blocks SET tool_name = ?1, tool_input_json = ?2, tool_output_json = ?3, ink_undo_json = ?4 WHERE id = ?5",
            params![tool_name, tool_input.to_string(), output.to_string(), receipt.to_string(), BLOCK_ID],
        ).expect("save exact undo receipt fixture");
    }

    fn seed_ai_apply(
        vfs_db: &crate::vfs::VfsDatabase,
    ) -> (String, String, String, String, Vec<String>, String) {
        let created = ink_commands::create(
            vfs_db,
            InkCreateRequest {
                title: "Undo test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1000.0,
                operation_id: "undo-test-create".to_owned(),
                folder_id: None,
            },
        )
        .expect("create Ink document");
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let (applied, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &created.revision,
            &scoped_ai_operation_id(SESSION_ID),
            &[InkOperation::AppendBlankPage {
                page_id: "ai-appended-page".to_owned(),
                width: 800.0,
                height: 1000.0,
                ruling: InkRuling::Blank,
            }],
            &[],
        )
        .expect("apply AI append-page operation");
        let ai_revision = applied.revision.clone();
        let input_hash = applied
            .last_operation
            .as_ref()
            .expect("canonical apply receipt")
            .input_hash
            .clone();
        assert_eq!(result.appended_page_ids, vec!["ai-appended-page"]);

        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &created.pages[0].page_id,
        )
        .expect("load page for later human stroke");
        page.objects.push(InkObject {
            id: "human-stroke-after-ai".to_owned(),
            author: InkAuthor::User,
            created_at: 2,
            content: InkObjectContent::Stroke {
                samples: vec![
                    InkSample {
                        x: 20.0,
                        y: 20.0,
                        pressure: 0.5,
                        elapsed_ms: Some(0.0),
                    },
                    InkSample {
                        x: 40.0,
                        y: 45.0,
                        pressure: 0.8,
                        elapsed_ms: Some(1.0),
                    },
                ],
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#1f2937".to_owned(),
                    width: 2.0,
                    pressure_enabled: true,
                },
            },
        });
        let current = VfsInkRepo::save_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &applied.revision,
            "later-human-stroke",
            &page,
        )
        .expect("save later human stroke");
        (
            created.document_id,
            created.revision,
            ai_revision,
            current.revision,
            result.appended_page_ids,
            input_hash,
        )
    }

    #[test]
    fn trusted_committed_receipt_undo_preserves_later_human_stroke() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let (
            document_id,
            previous_revision,
            ai_revision,
            current_revision,
            appended_pages,
            vfs_input_hash,
        ) = seed_ai_apply(&vfs_db);
        seed_receipt(
            &chat_db,
            &document_id,
            &previous_revision,
            &ai_revision,
            &vfs_input_hash,
            &appended_pages,
            "builtin-ink_apply_ops",
            true,
            SESSION_ID,
        );

        let undone = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            UNDO_OPERATION_ID,
        )
        .expect("trusted committed receipt should undo");

        assert_eq!(undone.document_id, document_id);
        assert_eq!(undone.operation_id, UNDO_OPERATION_ID);
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let manifest = VfsInkRepo::get_manifest_with_conn(&conn, vfs_db.blobs_dir(), &document_id)
            .expect("load post-undo manifest");
        assert!(!manifest
            .pages
            .iter()
            .any(|page| page.page_id == "ai-appended-page"));
        let original_page = VfsInkRepo::get_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &document_id,
            &manifest.pages[0].page_id,
        )
        .expect("load post-undo page");
        assert!(original_page
            .objects
            .iter()
            .any(|object| object.id == "human-stroke-after-ai"));
        assert_ne!(manifest.revision, current_revision);
    }

    #[test]
    fn undo_retry_with_same_operation_id_and_original_revision_is_idempotent() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let (
            document_id,
            previous_revision,
            ai_revision,
            current_revision,
            appended_pages,
            vfs_input_hash,
        ) = seed_ai_apply(&vfs_db);
        seed_receipt(
            &chat_db,
            &document_id,
            &previous_revision,
            &ai_revision,
            &vfs_input_hash,
            &appended_pages,
            "builtin-ink_apply_ops",
            true,
            SESSION_ID,
        );

        let first = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            UNDO_OPERATION_ID,
        )
        .expect("initial trusted undo");
        let retry = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            UNDO_OPERATION_ID,
        )
        .expect("exact retry must return the committed undo");

        assert_eq!(retry, first);
    }

    fn seed_ai_append_with_human_content_on_appended_page(
        vfs_db: &crate::vfs::VfsDatabase,
    ) -> (String, String, String, String, Vec<String>, String) {
        let created = ink_commands::create(
            vfs_db,
            InkCreateRequest {
                title: "Appended page conflict test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1000.0,
                operation_id: "undo-appended-conflict-create".to_owned(),
                folder_id: None,
            },
        )
        .expect("create Ink document");
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let (applied, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &created.revision,
            &scoped_ai_operation_id(SESSION_ID),
            &[InkOperation::AppendBlankPage {
                page_id: "ai-appended-page".to_owned(),
                width: 800.0,
                height: 1000.0,
                ruling: InkRuling::Blank,
            }],
            &[],
        )
        .expect("apply trusted append-page operation");
        let ai_revision = applied.revision.clone();
        let input_hash = applied
            .last_operation
            .as_ref()
            .expect("canonical apply receipt")
            .input_hash
            .clone();
        let mut page = VfsInkRepo::get_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            "ai-appended-page",
        )
        .expect("load appended page");
        page.objects.push(InkObject {
            id: "human-object-on-ai-page".to_owned(),
            author: InkAuthor::User,
            created_at: 3,
            content: InkObjectContent::Stroke {
                samples: vec![
                    InkSample {
                        x: 10.0,
                        y: 10.0,
                        pressure: 0.5,
                        elapsed_ms: Some(0.0),
                    },
                    InkSample {
                        x: 30.0,
                        y: 35.0,
                        pressure: 0.8,
                        elapsed_ms: Some(1.0),
                    },
                ],
                style: InkStrokeStyle {
                    tool: InkTool::Pen,
                    color: "#1f2937".to_owned(),
                    width: 2.0,
                    pressure_enabled: true,
                },
            },
        });
        let current = VfsInkRepo::save_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &ai_revision,
            "human-content-on-appended-page",
            &page,
        )
        .expect("save human content on appended page");
        (
            created.document_id,
            created.revision,
            ai_revision,
            current.revision,
            result.appended_page_ids,
            input_hash,
        )
    }

    #[test]
    fn undo_conflicts_when_ai_appended_page_has_later_human_content() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let (
            document_id,
            previous_revision,
            ai_revision,
            current_revision,
            appended_pages,
            vfs_input_hash,
        ) = seed_ai_append_with_human_content_on_appended_page(&vfs_db);
        seed_receipt(
            &chat_db,
            &document_id,
            &previous_revision,
            &ai_revision,
            &vfs_input_hash,
            &appended_pages,
            "builtin-ink_apply_ops",
            true,
            SESSION_ID,
        );

        let error = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            "undo-page-with-human-content",
        )
        .expect_err("appended page with later human content must conflict");
        assert_eq!(error.code, "REVISION_CONFLICT");

        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let manifest = VfsInkRepo::get_manifest_with_conn(&conn, vfs_db.blobs_dir(), &document_id)
            .expect("load unchanged manifest");
        assert_eq!(manifest.revision, current_revision);
        assert!(manifest
            .pages
            .iter()
            .any(|page| page.page_id == "ai-appended-page"));
        let page = VfsInkRepo::get_page_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &document_id,
            "ai-appended-page",
        )
        .expect("load unchanged appended page");
        assert!(page
            .objects
            .iter()
            .any(|object| object.id == "human-object-on-ai-page"));
    }

    #[test]
    fn prepared_receipt_recovers_only_while_canonical_apply_is_latest() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let created = ink_commands::create(
            &vfs_db,
            InkCreateRequest {
                title: "Prepared operation test".to_owned(),
                ruling: InkRuling::Blank,
                width: 800.0,
                height: 1000.0,
                operation_id: "undo-prepared-create".to_owned(),
                folder_id: None,
            },
        )
        .expect("create Ink document");
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let (applied, result) = VfsInkOperationRepo::apply_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            &created.document_id,
            &created.revision,
            &scoped_ai_operation_id(SESSION_ID),
            &[InkOperation::AppendBlankPage {
                page_id: "ai-appended-page".to_owned(),
                width: 800.0,
                height: 1000.0,
                ruling: InkRuling::Blank,
            }],
            &[],
        )
        .expect("apply operation before simulating receipt-finalize interruption");
        let vfs_input_hash = applied
            .last_operation
            .as_ref()
            .expect("canonical apply receipt")
            .input_hash
            .clone();
        seed_receipt(
            &chat_db,
            &created.document_id,
            &created.revision,
            &applied.revision,
            &vfs_input_hash,
            &result.appended_page_ids,
            "builtin-ink_apply_ops",
            false,
            SESSION_ID,
        );

        let undone = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &applied.revision,
            "undo-prepared-latest",
        )
        .expect("latest canonical apply proves a prepared receipt committed");
        assert_eq!(undone.document_id, created.document_id);
        let manifest =
            VfsInkRepo::get_manifest_with_conn(&conn, vfs_db.blobs_dir(), &created.document_id)
                .expect("load recovered undo");
        assert!(!manifest
            .pages
            .iter()
            .any(|page| page.page_id == "ai-appended-page"));
    }

    #[test]
    fn malformed_receipt_wrong_tool_call_and_modified_public_input_reject() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let (
            document_id,
            previous_revision,
            ai_revision,
            current_revision,
            appended_pages,
            vfs_input_hash,
        ) = seed_ai_apply(&vfs_db);
        seed_receipt(
            &chat_db,
            &document_id,
            &previous_revision,
            &ai_revision,
            &vfs_input_hash,
            &appended_pages,
            "builtin-ink_apply_ops",
            true,
            SESSION_ID,
        );
        let conn = chat_db.get_conn_safe().expect("Chat connection");
        let (tool_input, receipt, tool_call_id): (String, String, String) = conn.query_row(
            "SELECT tool_input_json, ink_undo_json, tool_call_id FROM chat_v2_blocks WHERE id = ?1",
            [BLOCK_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).expect("read original trusted receipt fields");

        conn.execute(
            "UPDATE chat_v2_blocks SET tool_call_id = 'different-provider-call' WHERE id = ?1",
            [BLOCK_ID],
        )
        .expect("change persisted provider call identity");
        assert!(
            undo_ink_operation(
                &vfs_db,
                &chat_db,
                SESSION_ID,
                MESSAGE_ID,
                BLOCK_ID,
                &current_revision,
                "undo-wrong-call",
            )
            .is_err(),
            "receipt call ID must match the stored provider replay ID"
        );
        conn.execute(
            "UPDATE chat_v2_blocks SET tool_call_id = ?1 WHERE id = ?2",
            params![tool_call_id, BLOCK_ID],
        )
        .expect("restore provider call identity");

        conn.execute("UPDATE chat_v2_blocks SET ink_undo_json = json_set(ink_undo_json, '$.untrusted_field', 1) WHERE id = ?1", [BLOCK_ID])
            .expect("add an unknown receipt field");
        assert!(
            undo_ink_operation(
                &vfs_db,
                &chat_db,
                SESSION_ID,
                MESSAGE_ID,
                BLOCK_ID,
                &current_revision,
                "undo-malformed-receipt",
            )
            .is_err(),
            "receipt schema must reject unknown fields"
        );
        conn.execute(
            "UPDATE chat_v2_blocks SET ink_undo_json = ?1 WHERE id = ?2",
            params![receipt, BLOCK_ID],
        )
        .expect("restore original receipt");

        conn.execute("UPDATE chat_v2_blocks SET tool_input_json = json_set(tool_input_json, '$.ops[0].width', 801) WHERE id = ?1", [BLOCK_ID])
            .expect("change public apply input after receipt creation");
        assert!(
            undo_ink_operation(
                &vfs_db,
                &chat_db,
                SESSION_ID,
                MESSAGE_ID,
                BLOCK_ID,
                &current_revision,
                "undo-modified-public-input",
            )
            .is_err(),
            "receipt input hash must bind the persisted public tool input"
        );
        conn.execute(
            "UPDATE chat_v2_blocks SET tool_input_json = ?1 WHERE id = ?2",
            params![tool_input, BLOCK_ID],
        )
        .expect("restore original public tool input");

        let vfs_conn = vfs_db.get_conn_safe().expect("VFS connection");
        let manifest =
            VfsInkRepo::get_manifest_with_conn(&vfs_conn, vfs_db.blobs_dir(), &document_id)
                .expect("load unchanged VFS manifest");
        assert_eq!(manifest.revision, current_revision);
    }

    #[test]
    fn forged_session_wrong_tool_and_uncommitted_receipts_reject_without_mutation() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let (_chat_temp, chat_db) = migrated_chat_db();
        let (
            document_id,
            previous_revision,
            ai_revision,
            current_revision,
            appended_pages,
            vfs_input_hash,
        ) = seed_ai_apply(&vfs_db);
        seed_receipt(
            &chat_db,
            &document_id,
            &previous_revision,
            &ai_revision,
            &vfs_input_hash,
            &appended_pages,
            "builtin-ink_apply_ops",
            true,
            SESSION_ID,
        );

        let forged = undo_ink_operation(
            &vfs_db,
            &chat_db,
            "forged-session",
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            "undo-forged-session",
        );
        assert!(
            forged.is_err(),
            "receipt in another session must not authorize undo"
        );

        let conn = chat_db.get_conn_safe().expect("Chat connection");
        conn.execute(
            "UPDATE chat_v2_blocks SET tool_name = 'builtin-ink_export' WHERE id = ?1",
            [BLOCK_ID],
        )
        .expect("make receipt's tool name untrusted");
        let wrong_tool = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            "undo-wrong-tool",
        );
        assert!(wrong_tool.is_err(), "another tool must not authorize undo");

        conn.execute("UPDATE chat_v2_blocks SET tool_name = 'builtin-ink_apply_ops', ink_undo_json = json_set(ink_undo_json, '$.committed', json('false')) WHERE id = ?1", [BLOCK_ID])
            .expect("make receipt uncommitted");
        let uncommitted = undo_ink_operation(
            &vfs_db,
            &chat_db,
            SESSION_ID,
            MESSAGE_ID,
            BLOCK_ID,
            &current_revision,
            "undo-uncommitted",
        );
        assert!(
            uncommitted.is_err(),
            "prepared receipt alone must not authorize undo"
        );

        let vfs_conn = vfs_db.get_conn_safe().expect("VFS connection");
        let manifest =
            VfsInkRepo::get_manifest_with_conn(&vfs_conn, vfs_db.blobs_dir(), &document_id)
                .expect("load unchanged manifest");
        assert_eq!(manifest.revision, current_revision);
        assert!(manifest
            .pages
            .iter()
            .any(|page| page.page_id == "ai-appended-page"));
        let page = VfsInkRepo::get_page_with_conn(
            &vfs_conn,
            vfs_db.blobs_dir(),
            &document_id,
            &manifest.pages[0].page_id,
        )
        .expect("load unchanged human page");
        assert!(page
            .objects
            .iter()
            .any(|object| object.id == "human-stroke-after-ai"));
    }
}
