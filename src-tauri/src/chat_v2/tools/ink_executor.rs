use std::{collections::BTreeSet, time::Instant};

use async_trait::async_trait;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::ink::{
    InkCoordinateSpace, InkNormalizedPoint, InkNormalizedRect, InkObject, InkObjectContent,
    InkOperation, InkOperationContent, InkPage, InkRect, InkRenderMapping, InkRuling,
};
use crate::vfs::ink_commands::{
    self, InkCommandError, InkCreateRequest, InkGetPageRequest, InkGetRequest,
};
use crate::vfs::repos::{
    InkArtifact, VfsBlobRepo, VfsInkArtifactRepo, VfsInkOperationRepo, VfsInkRepo,
};
use dstu_core::agent::InkVisualArtifactRef;

const INK_TOOLS: &[&str] = &[
    "ink_prepare",
    "ink_create",
    "ink_get",
    "ink_render",
    "ink_apply_ops",
    "ink_export",
];
const MAX_OBJECT_LIMIT: usize = 100;
const DEFAULT_OBJECT_LIMIT: usize = 50;
const INK_UNDO_MAX_BYTES: usize = 16 * 1024 * 1024;
const INK_UNDO_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkApplyArgs {
    document_id: String,
    expected_revision: String,
    operation_id: String,
    ops: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkRenderArgs {
    document_id: String,
    expected_revision: String,
    page_id: String,
    #[serde(default, deserialize_with = "present_non_null")]
    crop: Option<InkNormalizedRect>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkPrepareArgs {
    source_resource_id: String,
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkExportArgs {
    document_id: String,
    expected_revision: String,
    page_ids: Vec<String>,
    format: String,
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkToolOpInput {
    op: String,
    #[serde(default, deserialize_with = "present_non_null")]
    page_id: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    object_id: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    coordinate_space: Option<InkCoordinateSpace>,
    #[serde(default, deserialize_with = "present_non_null")]
    based_on_render_id: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    width: Option<f64>,
    #[serde(default, deserialize_with = "present_non_null")]
    height: Option<f64>,
    #[serde(default, deserialize_with = "present_non_null")]
    ruling: Option<InkRuling>,
    #[serde(default, deserialize_with = "present_non_null")]
    rect: Option<InkNormalizedRect>,
    #[serde(default, deserialize_with = "present_non_null")]
    text: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    font_size: Option<f64>,
    #[serde(default, deserialize_with = "present_non_null")]
    color: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    from: Option<InkNormalizedPoint>,
    #[serde(default, deserialize_with = "present_non_null")]
    to: Option<InkNormalizedPoint>,
    #[serde(default, deserialize_with = "present_non_null")]
    content: Option<InkToolContentInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkToolContentInput {
    kind: String,
    #[serde(default, deserialize_with = "present_non_null")]
    rect: Option<InkNormalizedRect>,
    #[serde(default, deserialize_with = "present_non_null")]
    text: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    font_size: Option<f64>,
    #[serde(default, deserialize_with = "present_non_null")]
    color: Option<String>,
    #[serde(default, deserialize_with = "present_non_null")]
    width: Option<f64>,
    #[serde(default, deserialize_with = "present_non_null")]
    from: Option<InkNormalizedPoint>,
    #[serde(default, deserialize_with = "present_non_null")]
    to: Option<InkNormalizedPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InkUndoReceipt {
    pub(crate) schema_version: u32,
    pub(crate) session_id: String,
    pub(crate) message_id: String,
    pub(crate) block_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) document_id: String,
    pub(crate) operation_id: String,
    pub(crate) input_hash: String,
    pub(crate) created_at: i64,
    pub(crate) previous_revision: String,
    pub(crate) result_revision: Option<String>,
    pub(crate) vfs_input_hash: String,
    pub(crate) object_changes: Vec<InkUndoObjectChange>,
    pub(crate) appended_page_ids: Vec<String>,
    pub(crate) committed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InkUndoObjectChange {
    pub(crate) page_id: String,
    pub(crate) object_id: String,
    pub(crate) before: Option<InkObject>,
    pub(crate) after: Option<InkObject>,
}

#[derive(Serialize)]
struct InkApplyInput<'a> {
    document_id: &'a str,
    expected_revision: &'a str,
    operations: &'a [InkOperation],
    mappings: &'a [InkRenderMapping],
}

fn present_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn parse_apply_arguments(value: &Value) -> Result<(InkApplyArgs, String), Value> {
    arguments_object(
        value,
        &["document_id", "expected_revision", "operation_id", "ops"],
    )?;
    let bytes = serde_json::to_vec(value).map_err(|_| invalid_apply_arguments())?;
    let args: InkApplyArgs =
        serde_json::from_slice(&bytes).map_err(|_| invalid_apply_arguments())?;
    if args.document_id.trim().is_empty()
        || args.document_id.chars().count() > 128
        || args.expected_revision.trim().is_empty()
        || args.expected_revision.chars().count() > 128
        || args.operation_id.trim().is_empty()
        || args.operation_id.chars().count() > 128
        || args
            .operation_id
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        || !(1..=100).contains(&args.ops.len())
    {
        return Err(invalid_apply_arguments());
    }
    let input_hash = public_apply_input_hash(&args)?;
    Ok((args, input_hash))
}

fn public_apply_input_hash(args: &InkApplyArgs) -> Result<String, Value> {
    let input_bytes = serde_json::to_vec(&(&args.document_id, &args.expected_revision, &args.ops))
        .map_err(|_| invalid_apply_arguments())?;
    Ok(hex::encode(Sha256::digest(input_bytes)))
}

fn invalid_apply_arguments() -> Value {
    error_output(
        "INVALID_ARGUMENT",
        "Ink apply arguments do not match the strict tool schema.",
        "Use 1–100 known operations and omit generated IDs, author, and timestamps.",
        false,
    )
}

fn stable_item_id(operation_id: &str, index: usize, kind: &str) -> String {
    let identity = format!("deepstudent.ink.{kind}.v1\0{operation_id}\0{index}");
    format!("ai-{}", hex::encode(Sha256::digest(identity.as_bytes())))
}

fn tool_field<T>(value: Option<T>, field: &str) -> Result<T, Value> {
    value.ok_or_else(|| {
        error_output(
            "INVALID_ARGUMENT",
            format!("An Ink operation is missing '{field}'."),
            "Correct the operation to match the tool schema.",
            false,
        )
    })
}

fn valid_tool_fields(input: &InkToolOpInput, allowed: &[&str]) -> bool {
    [
        ("page_id", input.page_id.is_some()),
        ("object_id", input.object_id.is_some()),
        ("coordinate_space", input.coordinate_space.is_some()),
        ("based_on_render_id", input.based_on_render_id.is_some()),
        ("width", input.width.is_some()),
        ("height", input.height.is_some()),
        ("ruling", input.ruling.is_some()),
        ("rect", input.rect.is_some()),
        ("text", input.text.is_some()),
        ("font_size", input.font_size.is_some()),
        ("color", input.color.is_some()),
        ("from", input.from.is_some()),
        ("to", input.to.is_some()),
        ("content", input.content.is_some()),
    ]
    .into_iter()
    .all(|(name, present)| !present || allowed.contains(&name))
}

fn parse_tool_content(value: InkToolContentInput) -> Result<InkOperationContent, Value> {
    let present = [
        ("rect", value.rect.is_some()),
        ("text", value.text.is_some()),
        ("font_size", value.font_size.is_some()),
        ("color", value.color.is_some()),
        ("width", value.width.is_some()),
        ("from", value.from.is_some()),
        ("to", value.to.is_some()),
    ];
    let fields = |allowed: &[&str]| {
        present
            .iter()
            .all(|(name, has_value)| !has_value || allowed.contains(name))
    };
    let invalid = || invalid_apply_arguments();
    match value.kind.as_str() {
        "text" if fields(&["rect", "text", "font_size", "color"]) => {
            let text = tool_field(value.text, "text")?;
            let font_size = tool_field(value.font_size, "font_size")?;
            if text.trim().is_empty()
                || text.chars().count() > 10_000
                || !(1.0..=256.0).contains(&font_size)
            {
                return Err(invalid());
            }
            Ok(InkOperationContent::Text {
                rect: tool_field(value.rect, "rect")?,
                text,
                font_size,
                color: tool_field(value.color, "color")?,
            })
        }
        "rect" | "ellipse" | "region_highlight" if fields(&["rect", "color", "width"]) => {
            let width = tool_field(value.width, "width")?;
            if !(0.001..=256.0).contains(&width) {
                return Err(invalid());
            }
            let rect = tool_field(value.rect, "rect")?;
            let color = tool_field(value.color, "color")?;
            Ok(match value.kind.as_str() {
                "rect" => InkOperationContent::Rect { rect, color, width },
                "ellipse" => InkOperationContent::Ellipse { rect, color, width },
                _ => InkOperationContent::RegionHighlight { rect, color, width },
            })
        }
        "arrow" if fields(&["from", "to", "color", "width"]) => {
            let width = tool_field(value.width, "width")?;
            if !(0.001..=256.0).contains(&width) {
                return Err(invalid());
            }
            Ok(InkOperationContent::Arrow {
                from: tool_field(value.from, "from")?,
                to: tool_field(value.to, "to")?,
                color: tool_field(value.color, "color")?,
                width,
            })
        }
        _ => Err(invalid()),
    }
}

fn parse_tool_operation(
    value: &Value,
    operation_id: &str,
    index: usize,
    created_at: i64,
) -> Result<InkOperation, Value> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid_apply_arguments())?;
    let input: InkToolOpInput =
        serde_json::from_slice(&bytes).map_err(|_| invalid_apply_arguments())?;
    let page_id = || tool_field(input.page_id.clone(), "page_id");
    let object_id = || tool_field(input.object_id.clone(), "object_id");
    let coordinate_space = || tool_field(input.coordinate_space, "coordinate_space");
    let render_id = || tool_field(input.based_on_render_id.clone(), "based_on_render_id");
    let rect = || tool_field(input.rect, "rect");
    let color = || tool_field(input.color.clone(), "color");
    let width = || tool_field(input.width, "width");
    let generated_id = |kind| stable_item_id(operation_id, index, kind);
    let invalid = || invalid_apply_arguments();

    let operation = match input.op.as_str() {
        "append_blank_page" if valid_tool_fields(&input, &["width", "height", "ruling"]) => {
            let width = tool_field(input.width, "width")?;
            let height = tool_field(input.height, "height")?;
            if !(1.0..=16384.0).contains(&width)
                || width.fract() != 0.0
                || !(1.0..=16384.0).contains(&height)
                || height.fract() != 0.0
            {
                return Err(invalid());
            }
            InkOperation::AppendBlankPage {
                page_id: generated_id("page"),
                width,
                height,
                ruling: tool_field(input.ruling, "ruling")?,
            }
        }
        "add_text"
            if valid_tool_fields(
                &input,
                &[
                    "page_id",
                    "coordinate_space",
                    "based_on_render_id",
                    "rect",
                    "text",
                    "font_size",
                    "color",
                ],
            ) =>
        {
            let text = tool_field(input.text, "text")?;
            let font_size = tool_field(input.font_size, "font_size")?;
            if text.trim().is_empty()
                || text.chars().count() > 10_000
                || !(1.0..=256.0).contains(&font_size)
            {
                return Err(invalid());
            }
            InkOperation::AddText {
                page_id: page_id()?,
                object_id: generated_id("object"),
                created_at,
                coordinate_space: coordinate_space()?,
                based_on_render_id: render_id()?,
                rect: rect()?,
                text,
                font_size,
                color: color()?,
            }
        }
        "add_rect" | "add_ellipse" | "add_region_highlight"
            if valid_tool_fields(
                &input,
                &[
                    "page_id",
                    "coordinate_space",
                    "based_on_render_id",
                    "rect",
                    "color",
                    "width",
                ],
            ) =>
        {
            let stroke_width = width()?;
            if !(0.001..=256.0).contains(&stroke_width) {
                return Err(invalid());
            }
            let page_id = page_id()?;
            let object_id = generated_id("object");
            let coordinate_space = coordinate_space()?;
            let based_on_render_id = render_id()?;
            let rect = rect()?;
            let color = color()?;
            match input.op.as_str() {
                "add_rect" => InkOperation::AddRect {
                    page_id,
                    object_id,
                    created_at,
                    coordinate_space,
                    based_on_render_id,
                    rect,
                    color,
                    width: stroke_width,
                },
                "add_ellipse" => InkOperation::AddEllipse {
                    page_id,
                    object_id,
                    created_at,
                    coordinate_space,
                    based_on_render_id,
                    rect,
                    color,
                    width: stroke_width,
                },
                _ => InkOperation::AddRegionHighlight {
                    page_id,
                    object_id,
                    created_at,
                    coordinate_space,
                    based_on_render_id,
                    rect,
                    color,
                    width: stroke_width,
                },
            }
        }
        "add_arrow"
            if valid_tool_fields(
                &input,
                &[
                    "page_id",
                    "coordinate_space",
                    "based_on_render_id",
                    "from",
                    "to",
                    "color",
                    "width",
                ],
            ) =>
        {
            let stroke_width = width()?;
            if !(0.001..=256.0).contains(&stroke_width) {
                return Err(invalid());
            }
            InkOperation::AddArrow {
                page_id: page_id()?,
                object_id: generated_id("object"),
                created_at,
                coordinate_space: coordinate_space()?,
                based_on_render_id: render_id()?,
                from: tool_field(input.from, "from")?,
                to: tool_field(input.to, "to")?,
                color: color()?,
                width: stroke_width,
            }
        }
        "update_object"
            if valid_tool_fields(
                &input,
                &[
                    "page_id",
                    "object_id",
                    "coordinate_space",
                    "based_on_render_id",
                    "content",
                ],
            ) =>
        {
            InkOperation::UpdateObject {
                page_id: page_id()?,
                object_id: object_id()?,
                coordinate_space: coordinate_space()?,
                based_on_render_id: render_id()?,
                content: parse_tool_content(tool_field(input.content, "content")?)?,
            }
        }
        "remove_object" if valid_tool_fields(&input, &["page_id", "object_id"]) => {
            InkOperation::RemoveObject {
                page_id: page_id()?,
                object_id: object_id()?,
            }
        }
        _ => return Err(invalid()),
    };
    for id in operation_ids(&operation) {
        if id.trim().is_empty()
            || id.chars().count() > 128
            || id
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        {
            return Err(invalid());
        }
    }
    Ok(operation)
}

fn operation_ids(operation: &InkOperation) -> Vec<&str> {
    match operation {
        InkOperation::AppendBlankPage { page_id, .. } => vec![page_id],
        InkOperation::AddText {
            page_id,
            based_on_render_id,
            object_id,
            ..
        }
        | InkOperation::AddRect {
            page_id,
            based_on_render_id,
            object_id,
            ..
        }
        | InkOperation::AddEllipse {
            page_id,
            based_on_render_id,
            object_id,
            ..
        }
        | InkOperation::AddArrow {
            page_id,
            based_on_render_id,
            object_id,
            ..
        }
        | InkOperation::AddRegionHighlight {
            page_id,
            based_on_render_id,
            object_id,
            ..
        } => vec![page_id, object_id, based_on_render_id],
        InkOperation::UpdateObject {
            page_id,
            based_on_render_id,
            object_id,
            ..
        } => vec![page_id, object_id, based_on_render_id],
        InkOperation::RemoveObject { page_id, object_id } => vec![page_id, object_id],
    }
}

fn canonical_apply_hash(
    document_id: &str,
    expected_revision: &str,
    operations: &[InkOperation],
    mappings: &[InkRenderMapping],
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&InkApplyInput {
        document_id,
        expected_revision,
        operations,
        mappings,
    })
    .map_err(|error| error.to_string())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(crate) fn object_changes(receipt: &InkUndoReceipt) -> Vec<crate::vfs::ink::InkObjectChange> {
    receipt
        .object_changes
        .iter()
        .map(|change| crate::vfs::ink::InkObjectChange {
            page_id: change.page_id.clone(),
            object_id: change.object_id.clone(),
            before: change.before.clone(),
            after: change.after.clone(),
        })
        .collect()
}

fn parse_stored_undo_receipt(raw: &str) -> Result<InkUndoReceipt, String> {
    if raw.len() > INK_UNDO_MAX_BYTES {
        return Err("Stored Ink undo receipt exceeds its size limit.".to_owned());
    }
    let receipt: InkUndoReceipt = serde_json::from_str(raw)
        .map_err(|error| format!("Stored Ink undo receipt is malformed: {error}"))?;
    if receipt.schema_version != INK_UNDO_SCHEMA_VERSION
        || receipt.session_id.is_empty()
        || receipt.message_id.is_empty()
        || receipt.block_id.is_empty()
        || receipt.tool_call_id.is_empty()
        || receipt.document_id.is_empty()
        || receipt.operation_id.is_empty()
        || receipt.created_at < 0
        || receipt.previous_revision.is_empty()
        || receipt.object_changes.len() > 100
        || receipt.appended_page_ids.len() > 100
        || !valid_sha256_hex(&receipt.input_hash)
        || !valid_sha256_hex(&receipt.vfs_input_hash)
        || receipt
            .result_revision
            .as_ref()
            .is_some_and(|revision| revision.is_empty())
        || (receipt.committed != receipt.result_revision.is_some())
    {
        return Err("Stored Ink undo receipt failed schema or identity validation.".to_owned());
    }
    Ok(receipt)
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn receipt_matches_block(
    receipt: &InkUndoReceipt,
    actual_session_id: &str,
    actual_message_id: &str,
    actual_block_id: &str,
    actual_tool_name: &str,
    actual_tool_call_id: Option<&str>,
    actual_tool_input: Option<&str>,
) -> Result<bool, String> {
    if receipt.session_id != actual_session_id
        || receipt.message_id != actual_message_id
        || receipt.block_id != actual_block_id
        || actual_tool_name != "builtin-ink_apply_ops"
        || actual_tool_call_id.is_some_and(|actual| actual != receipt.tool_call_id)
    {
        return Ok(false);
    }
    let Some(input) = actual_tool_input else {
        return Ok(false);
    };
    let args: InkApplyArgs = serde_json::from_str(input)
        .map_err(|error| format!("Stored Ink apply input is malformed: {error}"))?;
    let public_hash = public_apply_input_hash(&args)
        .map_err(|_| "Stored Ink apply input is invalid.".to_owned())?;
    Ok(receipt.document_id == args.document_id && receipt.input_hash == public_hash)
}

fn load_undo_receipt(
    db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    operation_id: &str,
) -> Result<Option<InkUndoReceipt>, String> {
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let mut statement = conn.prepare(
        "SELECT b.ink_undo_json, b.id, b.message_id, b.tool_name, b.tool_call_id, b.tool_input_json, m.session_id FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id=b.message_id WHERE m.session_id=?1 AND b.ink_undo_json IS NOT NULL",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut found = None;
    for row in rows {
        let (raw, block_id, message_id, tool_name, tool_call_id, tool_input, actual_session_id) =
            row.map_err(|error| error.to_string())?;
        let receipt = parse_stored_undo_receipt(&raw)?;
        if !receipt_matches_block(
            &receipt,
            &actual_session_id,
            &message_id,
            &block_id,
            tool_name.as_deref().unwrap_or(""),
            tool_call_id.as_deref(),
            tool_input.as_deref(),
        )? {
            return Err("Stored Ink undo receipt does not match its persisted parent, tool, call, or public input.".to_owned());
        }
        if receipt.operation_id == operation_id {
            if found.is_some() {
                return Err("Multiple durable Ink receipts match this operation.".to_owned());
            }
            found = Some(receipt);
        }
    }
    Ok(found)
}

fn save_undo_receipt(
    db: &crate::chat_v2::database::ChatV2Database,
    receipt: &InkUndoReceipt,
    tool_input: &Value,
) -> Result<(), String> {
    let encoded = serde_json::to_string(receipt).map_err(|error| error.to_string())?;
    if encoded.len() > INK_UNDO_MAX_BYTES {
        return Err("Ink undo receipt exceeds its size limit.".to_owned());
    }
    let validated = parse_stored_undo_receipt(&encoded)?;
    let args_bytes = serde_json::to_vec(tool_input).map_err(|error| error.to_string())?;
    let args: InkApplyArgs =
        serde_json::from_slice(&args_bytes).map_err(|error| error.to_string())?;
    if public_apply_input_hash(&args).map_err(|_| "Ink apply input is invalid.".to_owned())?
        != validated.input_hash
        || args.document_id != validated.document_id
    {
        return Err("Ink receipt does not match the public apply input.".to_owned());
    }
    let input_json = serde_json::to_string(tool_input).map_err(|error| error.to_string())?;
    let mut conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO chat_v2_messages (id,session_id,role,block_ids_json,timestamp) VALUES (?1,?2,'assistant','[]',?3)",
        rusqlite::params![validated.message_id, validated.session_id, validated.created_at],
    ).map_err(|error| error.to_string())?;
    let actual_session: Option<String> = tx
        .query_row(
            "SELECT session_id FROM chat_v2_messages WHERE id=?1",
            [&validated.message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if actual_session.as_deref() != Some(validated.session_id.as_str()) {
        return Err("Ink receipt message does not belong to its trusted session.".to_owned());
    }
    let actual: Option<(String, String, Option<String>, Option<String>, Option<String>)> = tx.query_row(
        "SELECT message_id, COALESCE(tool_name,''), tool_call_id, tool_input_json, ink_undo_json FROM chat_v2_blocks WHERE id=?1",
        [&validated.block_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|error| error.to_string())?;
    if let Some((message_id, tool_name, tool_call_id, stored_input, stored_receipt)) = actual {
        if message_id != validated.message_id
            || tool_name != "builtin-ink_apply_ops"
            || tool_call_id
                .as_deref()
                .is_some_and(|actual| actual != validated.tool_call_id)
        {
            return Err("Existing Chat block parent, tool, or call identity does not match the Ink receipt.".to_owned());
        }
        if let Some(stored_input) = stored_input.as_deref() {
            let stored_args: InkApplyArgs = serde_json::from_str(stored_input)
                .map_err(|error| format!("Existing Chat block input is malformed: {error}"))?;
            if public_apply_input_hash(&stored_args)
                .map_err(|_| "Existing Chat block input is invalid.".to_owned())?
                != validated.input_hash
            {
                return Err("Existing Chat block input differs from the Ink receipt.".to_owned());
            }
        }
        if let Some(old_raw) = stored_receipt.as_deref() {
            let old = parse_stored_undo_receipt(old_raw)?;
            if old.session_id != validated.session_id
                || old.message_id != validated.message_id
                || old.block_id != validated.block_id
                || old.tool_call_id != validated.tool_call_id
                || old.document_id != validated.document_id
                || old.operation_id != validated.operation_id
                || old.input_hash != validated.input_hash
                || old.vfs_input_hash != validated.vfs_input_hash
                || old.created_at != validated.created_at
                || old.object_changes != validated.object_changes
                || old.appended_page_ids != validated.appended_page_ids
                || old.previous_revision != validated.previous_revision
                || old.created_at != validated.created_at
                || (old.committed && old != validated)
            {
                return Err(
                    "Existing Ink receipt cannot be replaced by a different operation.".to_owned(),
                );
            }
        }
        tx.execute(
            "UPDATE chat_v2_blocks SET tool_call_id=COALESCE(tool_call_id,?1), tool_input_json=COALESCE(tool_input_json,?2), ink_undo_json=?3 WHERE id=?4",
            rusqlite::params![validated.tool_call_id, input_json, encoded, validated.block_id],
        ).map_err(|error| error.to_string())?;
    } else {
        tx.execute(
            "INSERT INTO chat_v2_blocks (id,message_id,block_type,status,tool_name,tool_call_id,tool_input_json,ink_undo_json) VALUES (?1,?2,'mcp_tool','running','builtin-ink_apply_ops',?3,?4,?5)",
            rusqlite::params![validated.block_id, validated.message_id, validated.tool_call_id, input_json, encoded],
        ).map_err(|error| error.to_string())?;
    }
    tx.execute(
        "UPDATE chat_v2_messages SET block_ids_json=json_insert(block_ids_json,'$[#]',?1) WHERE id=?2 AND ?1 NOT IN (SELECT value FROM json_each(block_ids_json))",
        rusqlite::params![validated.block_id, validated.message_id],
    ).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn load_undo_receipt_for_block(
    db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    message_id: &str,
    block_id: &str,
) -> Result<Option<InkUndoReceipt>, String> {
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let row: Option<(Option<String>, String, String, String, Option<String>, Option<String>, String)> = conn.query_row(
        "SELECT b.ink_undo_json,b.id,b.message_id,COALESCE(b.tool_name,''),b.tool_call_id,b.tool_input_json,m.session_id FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id=b.message_id WHERE b.id=?1 AND b.message_id=?2 AND m.session_id=?3",
        rusqlite::params![block_id,message_id,session_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((
        raw,
        actual_block,
        actual_message,
        tool_name,
        tool_call_id,
        tool_input,
        actual_session,
    )) = row
    else {
        return Ok(None);
    };
    let Some(raw) = raw else {
        return Ok(None);
    };
    let receipt = parse_stored_undo_receipt(&raw)?;
    let matches = receipt_matches_block(
        &receipt,
        &actual_session,
        &actual_message,
        &actual_block,
        &tool_name,
        tool_call_id.as_deref(),
        tool_input.as_deref(),
    )?;
    if !matches {
        return Ok(None);
    }
    Ok(Some(receipt))
}

pub struct InkToolExecutor;

impl InkToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn tool_name(name: &str) -> &str {
        name.strip_prefix("builtin-").unwrap_or(name)
    }

    fn unsupported(name: &str) -> Value {
        error_output(
            "UNIMPLEMENTED",
            format!("Ink tool '{name}' is not implemented yet."),
            "Retry after its required Ink service is available.",
            false,
        )
    }

    fn execute_supported(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, Value> {
        if ctx.is_cancelled() {
            return Err(error_output(
                "CANCELLED",
                "Ink operation was cancelled before execution.",
                "Retry the operation if it is still needed.",
                true,
            ));
        }
        let name = Self::tool_name(&call.name);
        if !matches!(name, "ink_create" | "ink_get" | "ink_apply_ops") {
            return Err(Self::unsupported(name));
        }
        let db = ctx.vfs_db.as_deref().ok_or_else(|| {
            error_output(
                "DEPENDENCY_UNAVAILABLE",
                "The VFS database is unavailable.",
                "Retry after the local VFS is available.",
                true,
            )
        })?;
        match name {
            "ink_create" => self.create(&call.arguments, ctx, db),
            "ink_get" => self.get(&call.arguments, db),
            "ink_apply_ops" => Err(error_output(
                "INTERNAL",
                "Ink apply dispatch requires async execution.",
                "Retry the tool call.",
                true,
            )),
            _ => Err(Self::unsupported(name)),
        }
    }

    async fn execute_jobs(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, Value> {
        let name = Self::tool_name(&call.name);
        let db = ctx.vfs_db.clone().ok_or_else(|| {
            error_output(
                "DEPENDENCY_UNAVAILABLE",
                "The VFS database is unavailable.",
                "Retry after local VFS is available.",
                true,
            )
        })?;
        let app = ctx
            .try_window()
            .map(|window| window.app_handle().clone())
            .ok_or_else(|| {
                error_output(
                    "JOB_UNAVAILABLE",
                    "Ink rendering and conversion require the configured desktop webview.",
                    "Retry this visual operation in the desktop app.",
                    true,
                )
            })?;
        let tool_call_id = call.id.trim();
        if tool_call_id.is_empty() || ctx.run_id() != tool_call_id {
            return Err(error_output(
                "INVALID_ARGUMENT",
                "The trusted tool-call identity is unavailable.",
                "Retry this tool through the current Chat call.",
                false,
            ));
        }
        let cancellation = ctx.cancellation_token().cloned();
        match name {
            "ink_render" => {
                let bytes =
                    serde_json::to_vec(&call.arguments).map_err(|_| invalid_apply_arguments())?;
                let args: InkRenderArgs =
                    serde_json::from_slice(&bytes).map_err(|_| invalid_apply_arguments())?;
                if args.document_id.trim().is_empty()
                    || args.expected_revision.trim().is_empty()
                    || args.page_id.trim().is_empty()
                {
                    return Err(invalid_apply_arguments());
                }
                let db_for_crop = db.clone();
                let document_id = args.document_id.clone();
                let revision = args.expected_revision.clone();
                let page_id = args.page_id.clone();
                let normalized_crop = args.crop;
                let (crop, mapping_crop) = tauri::async_runtime::spawn_blocking(move || {
                    let conn = db_for_crop
                        .get_conn_safe()
                        .map_err(|error| error.to_string())?;
                    let manifest = VfsInkRepo::get_manifest_with_conn(
                        &conn,
                        db_for_crop.blobs_dir(),
                        &document_id,
                    )
                    .map_err(|error| error.to_string())?;
                    if manifest.revision != revision {
                        return Err("REVISION_CONFLICT".to_owned());
                    }
                    let page = manifest
                        .pages
                        .iter()
                        .find(|page| page.page_id == page_id)
                        .ok_or_else(|| "RESOURCE_NOT_FOUND".to_owned())?;
                    let full = InkRect {
                        x: 0.0,
                        y: 0.0,
                        width: page.width,
                        height: page.height,
                    };
                    let logical = normalized_crop.map(|crop| InkRect {
                        x: crop.x * page.width,
                        y: crop.y * page.height,
                        width: crop.width * page.width,
                        height: crop.height * page.height,
                    });
                    Ok::<_, String>((logical, logical.unwrap_or(full)))
                })
                .await
                .map_err(|error| {
                    error_output(
                        "INTERNAL",
                        error.to_string(),
                        "Retry after local VFS access is available.",
                        true,
                    )
                })?
                .map_err(|code| {
                    error_output(
                        &code,
                        "Ink render target or revision is unavailable.",
                        "Reload the document and render its current page.",
                        false,
                    )
                })?;
                let artifact = crate::ink_bridge::render_ink_snapshot(
                    &app,
                    db,
                    crate::ink_bridge::InkRenderSpec {
                        document_id: args.document_id.clone(),
                        expected_revision: args.expected_revision.clone(),
                        page_id: args.page_id.clone(),
                        crop,
                        long_edge: None,
                    },
                    Some(&ctx.session_id),
                    Some(tool_call_id),
                    cancellation,
                )
                .await
                .map_err(|error| {
                    error_output(
                        &error.code,
                        error.message,
                        "Retry after checking the Ink document and editor.",
                        error.code == "RENDER_UNAVAILABLE" || error.code == "EDITOR_BUSY",
                    )
                })?;
                let reference = persist_render_artifact_ref(ctx, call, &artifact)?;
                Ok(render_output(&reference, &artifact, mapping_crop))
            }
            "ink_prepare" => {
                let bytes =
                    serde_json::to_vec(&call.arguments).map_err(|_| invalid_apply_arguments())?;
                let args: InkPrepareArgs =
                    serde_json::from_slice(&bytes).map_err(|_| invalid_apply_arguments())?;
                let operation_id = scoped_operation_id(ctx, "prepare", &args.operation_id);
                let manifest = crate::ink_jobs::prepare_source_ink(
                    &app,
                    db,
                    &args.source_resource_id,
                    &operation_id,
                    Some(&ctx.session_id),
                    Some(tool_call_id),
                    cancellation,
                )
                .await
                .map_err(|error| {
                    error_output(
                        &error.code,
                        error.message,
                        "Retry after checking the source and local converter.",
                        error.code == "JOB_TIMEOUT" || error.code == "JOB_UNAVAILABLE",
                    )
                })?;
                let mut output = manifest_output(&manifest);
                output["operation_id"] = json!(operation_id);
                output["operation_status"] = json!("succeeded");
                Ok(output)
            }
            "ink_export" => {
                let bytes =
                    serde_json::to_vec(&call.arguments).map_err(|_| invalid_apply_arguments())?;
                let args: InkExportArgs =
                    serde_json::from_slice(&bytes).map_err(|_| invalid_apply_arguments())?;
                if args.page_ids.is_empty()
                    || args.page_ids.len() > 500
                    || args.page_ids.iter().collect::<BTreeSet<_>>().len() != args.page_ids.len()
                {
                    return Err(invalid_apply_arguments());
                }
                let format = match args.format.as_str() {
                    "png" => crate::ink_jobs::InkExportFormat::Png,
                    "pdf" => crate::ink_jobs::InkExportFormat::Pdf,
                    _ => return Err(invalid_apply_arguments()),
                };
                let operation_id = scoped_operation_id(ctx, "export", &args.operation_id);
                let artifact = crate::ink_jobs::export_ink_document(
                    &app,
                    db,
                    &args.document_id,
                    &args.expected_revision,
                    &args.page_ids,
                    format,
                    &operation_id,
                    Some(&ctx.session_id),
                    Some(tool_call_id),
                    cancellation,
                )
                .await
                .map_err(|error| {
                    error_output(
                        &error.code,
                        error.message,
                        "Reload the selected Ink pages and retry the export.",
                        error.code == "JOB_TIMEOUT" || error.code == "JOB_UNAVAILABLE",
                    )
                })?;
                let pages = artifact.page_ids.iter().map(|page_id| json!({"page_id":page_id,"artifact_id":artifact.artifact_id,"resource_id":artifact.resource_id,"file_id":artifact.file_id,"content_hash":artifact.content_hash,"mime_type":artifact.mime_type})).collect::<Vec<_>>();
                Ok(
                    json!({"status":"exported","document_id":artifact.document_id,"revision":artifact.revision,"pages":pages,"page_ids":artifact.page_ids,"format":artifact.format,"operation_id":artifact.operation_id,"resource_id":artifact.resource_id,"file_id":artifact.file_id,"open_locator":artifact.open_locator,"mime_type":artifact.mime_type,"content_hash":artifact.content_hash}),
                )
            }
            _ => Err(Self::unsupported(name)),
        }
    }

    async fn apply_ops(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        db: std::sync::Arc<crate::vfs::VfsDatabase>,
    ) -> Result<Value, Value> {
        let (args, public_input_hash) = parse_apply_arguments(&call.arguments)?;
        if ctx.is_cancelled() {
            return Err(error_output(
                "CANCELLED",
                "Ink apply was cancelled before any VFS mutation.",
                "Retry if the operation is still needed.",
                true,
            ));
        }
        if let Some(app) = ctx.try_window().map(|window| window.app_handle().clone()) {
            crate::ink_bridge::flush_ink_editor(&app, &args.document_id)
                .await
                .map_err(|error| {
                    let retryable = error.code == "EDITOR_BUSY";
                    error_output(
                        &error.code,
                        error.message,
                        "Save or close the Ink editor, then retry.",
                        retryable,
                    )
                })?;
        }
        if ctx.is_cancelled() {
            return Err(error_output(
                "CANCELLED",
                "Ink apply was cancelled before any VFS mutation.",
                "Retry if the operation is still needed.",
                true,
            ));
        }

        let operation_id = scoped_operation_id(ctx, "apply_ops", &args.operation_id);
        let chat_db = ctx.chat_v2_db.clone();
        if chat_db.is_none() {
            return Err(error_output(
                "DEPENDENCY_UNAVAILABLE",
                "Durable Chat storage is required for a truthful Ink apply receipt.",
                "Retry after Chat storage is available.",
                true,
            ));
        }
        let (existing_receipt, created_at) = if let Some(chat_db) = chat_db.as_ref() {
            let chat_db = chat_db.clone();
            let session_id = ctx.session_id.clone();
            let operation_id = operation_id.clone();
            let message_id = ctx.message_id.clone();
            let expected_public_input_hash = public_input_hash.clone();
            let expected_document_id = args.document_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let existing = load_undo_receipt(&chat_db, &session_id, &operation_id)?;
                if let Some(receipt) = existing.as_ref() {
                    if receipt.input_hash != expected_public_input_hash
                        || receipt.document_id != expected_document_id
                    {
                        return Err("Ink operation ID was reused with different input.".to_owned());
                    }
                    let created_at = receipt.created_at;
                    return Ok((existing, created_at));
                }
                let conn = chat_db.get_conn_safe().map_err(|error| error.to_string())?;
                let timestamp = conn
                    .query_row(
                        "SELECT timestamp FROM chat_v2_messages WHERE id = ?1",
                        [message_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
                Ok((None, timestamp))
            })
            .await
            .map_err(|error| {
                error_output(
                    "INTERNAL",
                    error.to_string(),
                    "Retry after checking Chat storage.",
                    true,
                )
            })?
            .map_err(|error| {
                error_output(
                    "INVALID_ARGUMENT",
                    error,
                    "Use a new operation_id for different input.",
                    false,
                )
            })?
        } else {
            (None, { chrono::Utc::now().timestamp_millis() })
        };

        let mut operations = Vec::with_capacity(args.ops.len());
        for (index, operation) in args.ops.iter().enumerate() {
            operations.push(parse_tool_operation(
                operation,
                &operation_id,
                index,
                created_at,
            )?);
        }
        let cancellation = ctx.cancellation_token().cloned();
        let document_id = args.document_id.clone();
        let expected_revision = args.expected_revision.clone();
        let operation_id_for_db = operation_id.clone();
        let db_for_apply = db.clone();
        let session_id = ctx.session_id.clone();
        let message_id = ctx.message_id.clone();
        let block_id = ctx.block_id.clone();
        let tool_call_id = call.id.clone();
        let tool_input = call.arguments.clone();
        let chat_db_for_apply = chat_db.clone();
        let existing_receipt_for_apply = existing_receipt.clone();
        let (manifest, affected_page_ids, committed, receipt_available, linked_receipt) = tauri::async_runtime::spawn_blocking(move || {
            if cancellation.as_ref().is_some_and(|token| token.is_cancelled()) {
                return Err(error_output("CANCELLED", "Ink apply was cancelled before any VFS mutation.", "Retry if the operation is still needed.", true));
            }
            let conn = db_for_apply.get_conn_safe().map_err(|error| error_output("VFS_STORAGE", error.to_string(), "Retry after local VFS storage is available.", true))?;
            let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db_for_apply.blobs_dir(), &document_id)
                .map_err(|error| command_error(InkCommandError::from(error)))?;
            let mut mappings = Vec::new();
            let mut seen = BTreeSet::new();
            for operation in &operations {
                let (page_id, render_id) = match operation {
                    InkOperation::AddText { page_id, based_on_render_id, .. }
                    | InkOperation::AddRect { page_id, based_on_render_id, .. }
                    | InkOperation::AddEllipse { page_id, based_on_render_id, .. }
                    | InkOperation::AddArrow { page_id, based_on_render_id, .. }
                    | InkOperation::AddRegionHighlight { page_id, based_on_render_id, .. }
                    | InkOperation::UpdateObject { page_id, based_on_render_id, .. } => (page_id, based_on_render_id),
                    _ => continue,
                };
                let page = manifest.pages.iter().find(|page| page.page_id == *page_id).ok_or_else(|| error_output("RESOURCE_NOT_FOUND", "Ink page was not found.", "Use a page ID from the current document.", false))?;
                if !seen.insert(render_id.clone()) { continue; }
                let artifact = VfsInkArtifactRepo::load_for_document_with_conn(&conn, db_for_apply.blobs_dir(), render_id, &document_id, &expected_revision)
                    .map_err(|error| match error {
                        crate::vfs::error::VfsError::Conflict { key, .. } if key == "ink.artifact.provenance_mismatch" => error_output("REVISION_CONFLICT", "Render artifact does not match this document revision.", "Render the requested page again and retry.", false),
                        other => command_error(InkCommandError::from(other)),
                    })?.0;
                if artifact.page_id != *page_id { return Err(error_output("REVISION_CONFLICT", "Render artifact belongs to a different page.", "Render the target page at the current revision.", false)); }
                mappings.push(InkRenderMapping { render_id: render_id.clone(), document_id: document_id.clone(), revision: expected_revision.clone(), page_id: page_id.clone(), crop: artifact.crop.unwrap_or(InkRect { x: 0.0, y: 0.0, width: page.width, height: page.height }) });
            }
            let apply_hash = canonical_apply_hash(&document_id, &expected_revision, &operations, &mappings)
                .map_err(|error| error_output("INTERNAL", error, "Retry after checking local serialization.", true))?;
            if let Some(receipt) = existing_receipt_for_apply.as_ref() {
                if receipt.vfs_input_hash != apply_hash { return Err(error_output("INVALID_ARGUMENT", "Ink operation ID was reused with different canonical input.", "Use a new operation_id for different input.", false)); }
                if receipt.committed {
                    if manifest.last_operation.as_ref().is_some_and(|canonical| canonical.operation_id == operation_id_for_db && canonical.input_hash == apply_hash && canonical.result_revision == manifest.revision && receipt.result_revision.as_deref() == Some(manifest.revision.as_str())) {
                        let mut affected = receipt.object_changes.iter().map(|change| change.page_id.clone()).chain(receipt.appended_page_ids.iter().cloned()).collect::<Vec<_>>();
                        affected.dedup();
                        let same_receipt_block = receipt.message_id == message_id && receipt.block_id == block_id;
                        return Ok((
                            manifest,
                            affected,
                            true,
                            same_receipt_block,
                            (!same_receipt_block).then(|| (receipt.message_id.clone(), receipt.block_id.clone())),
                        ));
                    }
                    return Err(error_output("OPERATION_STATE_UNKNOWN", "The previous Ink operation is no longer the verifiable latest VFS receipt.", "Reload the document and do not assume the operation succeeded.", false));
                }
                if manifest.revision != expected_revision {
                    if manifest.last_operation.as_ref().is_some_and(|canonical| canonical.operation_id == operation_id_for_db && canonical.input_hash == apply_hash && canonical.result_revision == manifest.revision) {
                        let mut promoted = receipt.clone();
                        promoted.committed = true;
                        promoted.result_revision = Some(manifest.revision.clone());
                        let saved = chat_db_for_apply.as_ref().is_some_and(|chat_db| save_undo_receipt(chat_db, &promoted, &tool_input).is_ok());
                        let mut affected = promoted.object_changes.iter().map(|change| change.page_id.clone()).chain(promoted.appended_page_ids.iter().cloned()).collect::<Vec<_>>();
                        affected.dedup();
                        let same_receipt_block = promoted.message_id == message_id && promoted.block_id == block_id;
                        return Ok((
                            manifest,
                            affected,
                            true,
                            saved && same_receipt_block,
                            (!same_receipt_block).then(|| (promoted.message_id, promoted.block_id)),
                        ));
                    }
                    return Err(error_output("OPERATION_STATE_UNKNOWN", "A prepared Ink operation cannot be proven at the current revision.", "Reload the document before retrying.", false));
                }
            } else if manifest.revision != expected_revision {
                return Err(error_output("REVISION_CONFLICT", "The Ink document revision changed before apply.", "Reload the document and render the current page.", false));
            }
            if cancellation.as_ref().is_some_and(|token| token.is_cancelled()) {
                return Err(error_output("CANCELLED", "Ink apply was cancelled before any VFS mutation.", "Retry if the operation is still needed.", true));
            }
            let pages = manifest.pages.iter().map(|page_ref| VfsInkRepo::get_page_with_conn(&conn, db_for_apply.blobs_dir(), &document_id, &page_ref.page_id)
                .map_err(|error| error_output("VFS_STORAGE", error.to_string(), "Retry after local VFS storage is available.", true)))
                .collect::<Result<Vec<_>, Value>>()?;
            let preview = crate::vfs::ink::apply_operations(&manifest, &pages, &operations, &mappings)
                .map_err(|error| error_output("INVALID_ARGUMENT", error.to_string(), "Correct the Ink operations and retry.", false))?;
            let mut receipt = existing_receipt_for_apply.clone().unwrap_or_else(|| InkUndoReceipt {
                schema_version: INK_UNDO_SCHEMA_VERSION, session_id: session_id.clone(), message_id: message_id.clone(), block_id: block_id.clone(), tool_call_id: tool_call_id.clone(),
                document_id: document_id.clone(), operation_id: operation_id_for_db.clone(), input_hash: public_input_hash.clone(), created_at,
                previous_revision: expected_revision.clone(), result_revision: None, vfs_input_hash: apply_hash.clone(), object_changes: preview.object_changes.iter().map(|change| InkUndoObjectChange { page_id: change.page_id.clone(), object_id: change.object_id.clone(), before: change.before.clone(), after: change.after.clone() }).collect(),
                appended_page_ids: preview.appended_page_ids.clone(), committed: false,
            });
            if receipt.object_changes != preview.object_changes.iter().map(|change| InkUndoObjectChange { page_id: change.page_id.clone(), object_id: change.object_id.clone(), before: change.before.clone(), after: change.after.clone() }).collect::<Vec<_>>() || receipt.appended_page_ids != preview.appended_page_ids {
                return Err(error_output("OPERATION_STATE_UNKNOWN", "Prepared undo data differs from canonical Ink operation preview.", "Do not retry or undo this operation automatically.", false));
            }
            if !receipt.committed {
                let chat_db = chat_db_for_apply.as_ref().ok_or_else(|| error_output("DEPENDENCY_UNAVAILABLE", "Durable undo receipt storage is unavailable.", "Retry after Chat storage is available.", true))?;
                save_undo_receipt(chat_db, &receipt, &tool_input).map_err(|error| error_output("RECEIPT_STORAGE_FAILED", error, "No Ink changes were committed; retry after Chat storage is available.", true))?;
            }
            if cancellation.as_ref().is_some_and(|token| token.is_cancelled()) {
                return Err(error_output("CANCELLED", "Ink apply was cancelled before any VFS mutation.", "Retry if the operation is still needed.", true));
            }
            let (committed_manifest, result) = VfsInkOperationRepo::apply_with_conn(&conn, db_for_apply.blobs_dir(), &document_id, &expected_revision, &operation_id_for_db, &operations, &mappings)
                .map_err(|error| command_error(InkCommandError::from(error)))?;
            let canonical = committed_manifest.last_operation.as_ref();
            if !canonical.is_some_and(|canonical| canonical.operation_id == operation_id_for_db && canonical.input_hash == apply_hash && canonical.result_revision == committed_manifest.revision) {
                return Err(error_output("OPERATION_STATE_UNKNOWN", "VFS commit receipt did not match the prepared Ink operation.", "Reload the document; undo is unavailable until verified.", false));
            }
            receipt.committed = true;
            receipt.result_revision = Some(committed_manifest.revision.clone());
            let receipt_saved = chat_db_for_apply.as_ref().is_some_and(|chat_db| save_undo_receipt(chat_db, &receipt, &tool_input).is_ok());
            Ok((committed_manifest, result.affected_page_ids, true, receipt_saved, None))
        }).await.map_err(|error| error_output("INTERNAL", error.to_string(), "Retry after checking local storage.", true))??;

        let mut output = json!({
            "status": "committed", "committed": committed, "document_id": manifest.document_id,
            "operation_id": operation_id, "revision": manifest.revision,
            "affected_page_ids": affected_page_ids, "undo_available": receipt_available,
        });
        if committed && ctx.is_cancelled() {
            output["cancellation_status"] = json!("committed");
        }
        if !receipt_available {
            output["receipt_status"] = json!("unavailable");
        }
        if let Some((message_id, block_id)) = linked_receipt {
            output["undo_receipt_message_id"] = json!(message_id);
            output["undo_receipt_block_id"] = json!(block_id);
        }
        Ok(output)
    }

    fn create(
        &self,
        arguments: &Value,
        ctx: &ExecutionContext,
        db: &crate::vfs::VfsDatabase,
    ) -> Result<Value, Value> {
        let object = arguments_object(
            arguments,
            &["title", "operation_id", "folder_id", "page_size", "ruling"],
        )?;
        let title = required_string(object, "title", 256)?;
        let client_operation_id = required_string(object, "operation_id", 128)?;
        let folder_id = optional_string(object, "folder_id", 128)?;
        let (width, height) = match object.get("page_size") {
            None => (794.0, 1123.0),
            Some(Value::Object(size)) => {
                if size
                    .keys()
                    .any(|key| !["width", "height"].contains(&key.as_str()))
                {
                    return Err(error_output(
                        "INVALID_ARGUMENT",
                        "page_size contains an unknown field.",
                        "Use only integer width and height fields.",
                        false,
                    ));
                }
                let width =
                    dimension(size.get("width").unwrap_or(&Value::Null), "page_size.width")?;
                let height = dimension(
                    size.get("height").unwrap_or(&Value::Null),
                    "page_size.height",
                )?;
                (width, height)
            }
            Some(_) => {
                return Err(error_output(
                    "INVALID_ARGUMENT",
                    "page_size must be an object with width and height.",
                    "Correct the arguments to match the tool schema.",
                    false,
                ));
            }
        };
        let ruling = match object.get("ruling") {
            None => InkRuling::Blank,
            Some(Value::String(ruling)) => match ruling.as_str() {
                "blank" => InkRuling::Blank,
                "lined" => InkRuling::Lined,
                "grid" => InkRuling::Grid,
                _ => {
                    return Err(error_output(
                        "INVALID_ARGUMENT",
                        "ruling must be blank, lined, or grid.",
                        "Correct the arguments to match the tool schema.",
                        false,
                    ));
                }
            },
            Some(_) => {
                return Err(error_output(
                    "INVALID_ARGUMENT",
                    "ruling must be blank, lined, or grid.",
                    "Correct the arguments to match the tool schema.",
                    false,
                ));
            }
        };
        if ctx.is_cancelled() {
            return Err(error_output(
                "CANCELLED",
                "Ink create was cancelled before any VFS mutation.",
                "Retry the operation if it is still needed.",
                true,
            ));
        }
        let operation_id = scoped_operation_id(ctx, "create", &client_operation_id);
        let manifest = ink_commands::create(
            db,
            InkCreateRequest {
                title,
                ruling,
                width,
                height,
                operation_id: operation_id.clone(),
                folder_id,
            },
        )
        .map_err(command_error)?;
        let mut output = manifest_output(&manifest);
        output["operation_id"] = json!(operation_id);
        output["operation_status"] = json!("succeeded");
        if ctx.is_cancelled() {
            output["cancellation_status"] = json!("committed");
        }
        Ok(output)
    }

    fn get(&self, arguments: &Value, db: &crate::vfs::VfsDatabase) -> Result<Value, Value> {
        let object = arguments_object(
            arguments,
            &[
                "document_id",
                "page_id",
                "page_index",
                "operation_id",
                "object_limit",
            ],
        )?;
        let document_id = required_string(object, "document_id", 128)?;
        let page_id = optional_string(object, "page_id", 128)?;
        let page_index = optional_u32(object, "page_index", 0, 499)?;
        if page_id.is_some() && page_index.is_some() {
            return Err(error_output(
                "INVALID_ARGUMENT",
                "Provide page_id or page_index, not both.",
                "Choose one page selector.",
                false,
            ));
        }
        let object_limit = optional_u32(object, "object_limit", 1, MAX_OBJECT_LIMIT as u32)?
            .unwrap_or(DEFAULT_OBJECT_LIMIT as u32) as usize;
        let operation_id = optional_string(object, "operation_id", 128)?;
        let manifest =
            ink_commands::get(db, InkGetRequest { document_id }).map_err(command_error)?;
        let operation_result = if let Some(operation_id) = operation_id {
            Some(
                manifest
                    .last_operation
                    .as_ref()
                    .filter(|receipt| receipt.operation_id == operation_id)
                    .map(|receipt| (operation_id, receipt.result_revision.clone()))
                    .ok_or_else(|| {
                        error_output(
                            "OPERATION_STATE_UNKNOWN",
                            "The requested operation is not the document's verifiable latest receipt.",
                            "Re-read the document and do not assume the operation succeeded.",
                            false,
                        )
                    })?,
            )
        } else {
            None
        };
        let selected_page = if let Some(page_id) = page_id.as_deref() {
            manifest.pages.iter().find(|page| page.page_id == page_id)
        } else if let Some(index) = page_index {
            manifest.pages.get(index as usize)
        } else {
            None
        };
        if (page_id.is_some() || page_index.is_some()) && selected_page.is_none() {
            return Err(error_output(
                "RESOURCE_NOT_FOUND",
                "The requested Ink page was not found.",
                "Use a page selector returned by the current manifest.",
                false,
            ));
        }
        let mut output = manifest_output(&manifest);
        if let Some((operation_id, result_revision)) = operation_result {
            output["operation_id"] = json!(operation_id);
            output["operation_status"] = json!("succeeded");
            output["result_revision"] = json!(result_revision);
        }
        if let Some(page_ref) = selected_page {
            let page = ink_commands::get_page(
                db,
                InkGetPageRequest {
                    document_id: manifest.document_id.clone(),
                    page_id: page_ref.page_id.clone(),
                },
            )
            .map_err(command_error)?;
            let total = page.objects.len();
            output["summary"]["object_count"] = json!(total);
            output["page"] = json!({
                "page_id": page_ref.page_id,
                "total_objects": total,
                "objects": page.objects.iter().take(object_limit).map(bounded_object).collect::<Vec<_>>(),
                "truncated": total > object_limit,
            });
        }
        Ok(output)
    }
}

impl Default for InkToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for InkToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        INK_TOOLS.contains(&Self::tool_name(tool_name))
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let execution = match Self::tool_name(&call.name) {
            "ink_apply_ops" => match ctx.vfs_db.clone() {
                Some(db) => self.apply_ops(call, ctx, db).await,
                None => Err(error_output(
                    "DEPENDENCY_UNAVAILABLE",
                    "The VFS database is unavailable.",
                    "Retry after the local VFS is available.",
                    true,
                )),
            },
            "ink_render" | "ink_prepare" | "ink_export" => self.execute_jobs(call, ctx).await,
            _ => self.execute_supported(call, ctx),
        };
        let mut result = match execution {
            Ok(output) => ToolResultInfo::success(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                output,
                started.elapsed().as_millis() as u64,
            ),
            Err(output) => {
                let error = output["message"]
                    .as_str()
                    .unwrap_or("Ink operation failed.")
                    .to_string();
                ToolResultInfo::failure_with_output(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    error,
                    started.elapsed().as_millis() as u64,
                )
            }
        };
        let persistence_error = ctx.save_tool_block(&result).err();
        if let Some(error) = persistence_error {
            log::error!(
                "[InkToolExecutor] Failed to persist terminal tool block: {}",
                error
            );
            if result.success {
                let committed = result.output["committed"].as_bool().unwrap_or(false)
                    || result.output["status"] == "committed";
                let code = if Self::tool_name(&call.name) == "ink_render" {
                    "IMAGE_DELIVERY_FAILED"
                } else if committed {
                    "COMMITTED_RESULT_NOT_PERSISTED"
                } else {
                    "TOOL_RESULT_NOT_PERSISTED"
                };
                result.output["code"] = json!(code);
                result.output["message"] = json!(if committed {
                    "The Ink change committed, but its terminal Chat result could not be persisted."
                } else if code == "IMAGE_DELIVERY_FAILED" {
                    "The rendered image was produced but the terminal Chat result could not be persisted."
                } else {
                    "The Ink tool result could not be persisted."
                });
                result.output["retryable"] = json!(false);
                if committed {
                    result.output["committed"] = json!(true);
                }
                result.error = result.output["message"].as_str().map(str::to_owned);
                result.success = false;
            }
        }
        if result.success {
            if Self::tool_name(&call.name) == "ink_apply_ops" {
                if let Some(window) = ctx.try_window() {
                    let _ = window.emit(
                        "ink:changed",
                        json!({
                            "document_id": result.output["document_id"],
                            "revision": result.output["revision"],
                            "affected_page_ids": result.output["affected_page_ids"],
                        }),
                    );
                }
            }
            ctx.emit_tool_call_end(Some(json!({"result": result.output.clone()})));
        } else {
            ctx.emit_tool_call_error(result.error.as_deref().unwrap_or("Ink operation failed."));
        }
        Ok(result)
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::tool_name(tool_name) {
            "ink_get" | "ink_render" => ToolSensitivity::Low,
            _ => ToolSensitivity::Medium,
        }
    }

    fn sensitivity_level_for_call(&self, tool_name: &str, arguments: &Value) -> ToolSensitivity {
        if Self::tool_name(tool_name) == "ink_apply_ops"
            && arguments
                .get("ops")
                .and_then(Value::as_array)
                .is_some_and(|ops| {
                    ops.iter().any(|op| {
                        matches!(
                            op.get("op").and_then(Value::as_str),
                            Some("update_object" | "remove_object")
                        )
                    })
                })
        {
            ToolSensitivity::High
        } else {
            self.sensitivity_level(tool_name)
        }
    }

    fn has_dynamic_sensitivity(&self, tool_name: &str) -> bool {
        Self::tool_name(tool_name) == "ink_apply_ops"
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        if Self::tool_name(tool_name) == "ink_get" {
            ToolConcurrency::ReadOnly
        } else {
            ToolConcurrency::Serial
        }
    }

    fn manages_cancellation(&self, tool_name: &str) -> bool {
        matches!(
            Self::tool_name(tool_name),
            "ink_create" | "ink_apply_ops" | "ink_prepare" | "ink_export" | "ink_render"
        )
    }

    fn name(&self) -> &'static str {
        "InkToolExecutor"
    }
}

fn arguments_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, Value> {
    let object = value.as_object().ok_or_else(|| {
        error_output(
            "INVALID_ARGUMENT",
            "Arguments must be a JSON object.",
            "Correct the arguments to match the tool schema.",
            false,
        )
    })?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(error_output(
            "INVALID_ARGUMENT",
            format!("Unknown argument '{unknown}'."),
            "Correct the arguments to match the tool schema.",
            false,
        ));
    }
    Ok(object)
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<String, Value> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_output(
                "INVALID_ARGUMENT",
                format!("'{field}' must be a nonempty string."),
                "Correct the arguments to match the tool schema.",
                false,
            )
        })?;
    if value.chars().count() > max_chars {
        return Err(error_output(
            "INVALID_ARGUMENT",
            format!("'{field}' exceeds {max_chars} characters."),
            "Correct the arguments to match the tool schema.",
            false,
        ));
    }
    Ok(value.to_owned())
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, Value> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        _ => required_string(object, field, max_chars).map(Some),
    }
}

fn dimension(value: &Value, field: &str) -> Result<f64, Value> {
    value
        .as_u64()
        .filter(|value| (1..=16_384).contains(value))
        .map(|value| value as f64)
        .ok_or_else(|| {
            error_output(
                "INVALID_ARGUMENT",
                format!("'{field}' must be an integer from 1 to 16384."),
                "Correct the arguments to match the tool schema.",
                false,
            )
        })
}

fn optional_u32(
    object: &Map<String, Value>,
    field: &str,
    minimum: u32,
    maximum: u32,
) -> Result<Option<u32>, Value> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| (minimum..=maximum).contains(value))
            .map(Some)
            .ok_or_else(|| {
                error_output(
                    "INVALID_ARGUMENT",
                    format!("'{field}' must be an integer from {minimum} to {maximum}."),
                    "Correct the arguments to match the tool schema.",
                    false,
                )
            }),
    }
}

fn error_output(code: &str, message: impl Into<String>, hint: &str, retryable: bool) -> Value {
    json!({
        "code": code,
        "message": message.into(),
        "hint": hint,
        "retryable": retryable,
    })
}

fn command_error(error: InkCommandError) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| {
        error_output(
            "INTERNAL",
            "Ink storage operation failed.",
            "Retry after checking local storage.",
            true,
        )
    })
}

fn scoped_operation_id(ctx: &ExecutionContext, tool: &str, client_id: &str) -> String {
    let input = format!(
        "deepstudent.ink.tool-operation.v1\0{}\0{tool}\0{client_id}",
        ctx.session_id
    );
    format!("agent-{}", hex::encode(Sha256::digest(input.as_bytes())))
}

fn manifest_output(manifest: &crate::vfs::ink::InkManifest) -> Value {
    let pages = manifest
        .pages
        .iter()
        .map(|page| {
            let background = match &page.background {
                crate::vfs::ink::InkBackground::Blank { ruling } => {
                    json!({"kind":"blank", "ruling":ruling})
                }
                crate::vfs::ink::InkBackground::Image { .. } => json!({"kind":"image"}),
                crate::vfs::ink::InkBackground::PdfPage {
                    source_page_index, ..
                } => json!({"kind":"pdf_page", "source_page_index":source_page_index}),
            };
            json!({
                "page_id": page.page_id,
                "width": page.width,
                "height": page.height,
                "background": background,
            })
        })
        .collect::<Vec<_>>();
    let source = match &manifest.source {
        crate::vfs::ink::InkSource::Blank {} => json!({"kind":"blank"}),
        crate::vfs::ink::InkSource::Resource {
            resource_id,
            conversion_revision,
            ..
        } => json!({
            "kind":"resource",
            "resource_id":resource_id,
            "conversion_revision":conversion_revision,
        }),
    };
    let last_operation = manifest.last_operation.as_ref().map(|receipt| {
        json!({
            "operation_id": receipt.operation_id,
            "status": "succeeded",
            "result_revision": receipt.result_revision,
        })
    });
    json!({
        "document_id": manifest.document_id,
        "revision": manifest.revision,
        "title": manifest.title,
        "source": source,
        "pages": pages,
        "summary": {"page_count": manifest.pages.len()},
        "last_operation": last_operation,
    })
}

fn persist_render_artifact_ref(
    ctx: &ExecutionContext,
    call: &ToolCall,
    artifact: &InkArtifact,
) -> Result<InkVisualArtifactRef, Value> {
    let tool_call_id = call.id.trim();
    let chat_db = ctx.chat_v2_db.as_ref().ok_or_else(|| {
        error_output(
            "IMAGE_DELIVERY_FAILED",
            "Chat storage is unavailable for this rendered image reference.",
            "Retry rendering after Chat storage is available.",
            true,
        )
    })?;
    if tool_call_id.is_empty() || ctx.run_id() != tool_call_id || ctx.block_id.trim().is_empty() {
        return Err(error_output(
            "IMAGE_DELIVERY_FAILED",
            "The rendered image has no trusted tool-call binding.",
            "Retry the render through the current Chat tool call.",
            false,
        ));
    }
    let reference = InkVisualArtifactRef {
        artifact_id: artifact.artifact_id.clone(),
        render_id: artifact.render_id.clone(),
        session_id: ctx.session_id.clone(),
        tool_call_id: tool_call_id.to_owned(),
        round_last_tool_call_id: tool_call_id.to_owned(),
        document_id: artifact.document_id.clone(),
        page_id: artifact.page_id.clone(),
        revision: artifact.revision.clone(),
        blob_hash: artifact.blob_hash.clone(),
        resource_id: artifact.resource_id.clone(),
        content_hash: artifact.content_hash.clone(),
        mime_type: artifact.mime_type.clone(),
        width_px: artifact.width_px,
        height_px: artifact.height_px,
    };
    let conn = chat_db.get_conn_safe().map_err(|error| {
        error_output(
            "IMAGE_DELIVERY_FAILED",
            error.to_string(),
            "Retry after Chat storage is available.",
            true,
        )
    })?;
    conn.execute(
        "INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) VALUES (?1, ?2, 'assistant', '[]', ?3)",
        rusqlite::params![ctx.message_id, ctx.session_id, chrono::Utc::now().timestamp_millis()],
    ).map_err(|error| error_output("IMAGE_DELIVERY_FAILED", error.to_string(), "Retry after Chat storage is available.", true))?;
    let refs_json = serde_json::to_string(&[reference.clone()]).map_err(|error| {
        error_output(
            "IMAGE_DELIVERY_FAILED",
            error.to_string(),
            "Retry after local persistence is available.",
            true,
        )
    })?;
    conn.execute(
        "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, tool_input_json, ink_artifacts_json) VALUES (?1, ?2, 'mcp_tool', 'running', 0, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET ink_artifacts_json = excluded.ink_artifacts_json",
        rusqlite::params![ctx.block_id, ctx.message_id, call.name, serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_owned()), refs_json],
    ).map_err(|error| error_output("IMAGE_DELIVERY_FAILED", error.to_string(), "Retry after Chat storage is available.", true))?;
    conn.execute(
        "UPDATE chat_v2_messages SET block_ids_json = json_insert(block_ids_json, '$[#]', ?1) WHERE id = ?2 AND ?1 NOT IN (SELECT value FROM json_each(block_ids_json))",
        rusqlite::params![ctx.block_id, ctx.message_id],
    ).map_err(|error| error_output("IMAGE_DELIVERY_FAILED", error.to_string(), "Retry after Chat storage is available.", true))?;
    Ok(reference)
}

fn render_output(reference: &InkVisualArtifactRef, artifact: &InkArtifact, crop: InkRect) -> Value {
    json!({
        "status":"rendered",
        "document_id":reference.document_id,
        "revision":reference.revision,
        "pages":[{
            "page_id":reference.page_id,
            "artifact_id":reference.artifact_id,
            "resource_id":reference.resource_id,
            "file_id":artifact.file_id,
            "render_id":reference.render_id,
            "mime_type":reference.mime_type,
            "width_px":reference.width_px,
            "height_px":reference.height_px,
            "crop":{"x":crop.x,"y":crop.y,"width":crop.width,"height":crop.height},
        }],
    })
}

fn bounded_object(object: &InkObject) -> Value {
    if let InkObjectContent::Stroke { samples, style } = &object.content {
        return json!({
            "id": object.id,
            "author": object.author,
            "created_at": object.created_at,
            "content": {
                "kind": "stroke",
                "sample_count": samples.len(),
                "style": style,
            },
        });
    }
    serde_json::to_value(object).unwrap_or_else(|_| json!({}))
}

#[cfg(test)]
mod tests {
    use super::{public_apply_input_hash, InkApplyArgs, InkToolExecutor};
    use crate::chat_v2::events::ChatV2EventEmitter;
    use crate::chat_v2::tools::{
        ExecutionContext, ToolExecutor, ToolExecutorRegistry, ToolSensitivity,
    };
    use crate::chat_v2::types::ToolCall;
    use crate::tools::ToolRegistry;
    use crate::vfs::database::setup_migrated_test_db;
    use crate::vfs::ink::{InkRect, InkRuling};
    use crate::vfs::ink_commands::{self, InkCreateRequest, InkGetPageRequest, InkRenameRequest};
    use crate::vfs::repos::ink_artifact_repo::{InkArtifactDraft, VfsInkArtifactRepo};
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn keep_test_chat_dir(dir: tempfile::TempDir) {
        static CHAT_DIRS: std::sync::OnceLock<std::sync::Mutex<Vec<tempfile::TempDir>>> =
            std::sync::OnceLock::new();
        CHAT_DIRS
            .get_or_init(|| std::sync::Mutex::new(Vec::new()))
            .lock()
            .expect("Chat test dirs")
            .push(dir);
    }

    fn context(db: Arc<crate::vfs::VfsDatabase>, block_id: &str) -> ExecutionContext {
        use crate::chat_v2::{
            database::ChatV2Database,
            repo::ChatV2Repo,
            types::{ChatMessage, ChatSession},
        };
        use crate::data_governance::{
            migration::coordinator::MigrationCoordinator, schema_registry::DatabaseId,
        };

        let chat_dir = tempfile::TempDir::new().expect("Chat V2 temp directory");
        MigrationCoordinator::new(chat_dir.path().to_path_buf())
            .with_audit_db(None)
            .migrate_single(DatabaseId::ChatV2)
            .expect("migrate Chat V2 test database");
        let chat_db = ChatV2Database::new(chat_dir.path()).expect("open migrated Chat V2 DB");
        let session_id = "ink-executor-test-session".to_string();
        let session = ChatSession::new(session_id.clone(), "chat".to_owned());
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("persist test session");
        let mut message = ChatMessage::new_assistant(session_id.clone());
        message.id = "ink-executor-test-message".to_owned();
        ChatV2Repo::create_message_v2(&chat_db, &message).expect("persist test message");
        keep_test_chat_dir(chat_dir);
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            session_id.clone(),
        ));
        let mut ctx = ExecutionContext::new(
            session_id,
            message.id,
            block_id.to_string(),
            emitter,
            Arc::new(ToolRegistry::new()),
            None,
        );
        ctx.vfs_db = Some(db);
        ctx.chat_v2_db = Some(Arc::new(chat_db));
        ctx.tool_call_id = Some("ink-call".to_owned());
        ctx
    }

    fn call(name: &str, arguments: Value) -> ToolCall {
        ToolCall::new("ink-call".to_string(), name.to_string(), arguments)
    }

    const TEST_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn add_text_ops(page_id: &str, render_id: &str) -> Value {
        json!([
            {
                "op":"add_text",
                "page_id":page_id,
                "coordinate_space":"page",
                "based_on_render_id":render_id,
                "rect":{"x":0.1,"y":0.1,"width":0.4,"height":0.1},
                "text":"ordered first",
                "font_size":16,
                "color":"#1f2937"
            },
            {
                "op":"add_arrow",
                "page_id":page_id,
                "coordinate_space":"render_crop",
                "based_on_render_id":render_id,
                "from":{"x":0.2,"y":0.3},
                "to":{"x":0.8,"y":0.7},
                "color":"#ef4444",
                "width":2
            }
        ])
    }

    fn apply_call(document_id: &str, revision: &str, operation_id: &str, ops: Value) -> ToolCall {
        call(
            "builtin-ink_apply_ops",
            json!({
                "document_id":document_id,
                "expected_revision":revision,
                "operation_id":operation_id,
                "ops":ops,
            }),
        )
    }

    fn apply_fixture(db: &crate::vfs::VfsDatabase) -> (crate::vfs::ink::InkManifest, String) {
        let manifest = ink_commands::create(
            db,
            InkCreateRequest {
                title: "Apply operation fixture".to_string(),
                ruling: InkRuling::Blank,
                width: 794.0,
                height: 1123.0,
                operation_id: format!("create-fixture-{}", nanoid::nanoid!(8)),
                folder_id: None,
            },
        )
        .expect("create actual Ink document");
        let page = &manifest.pages[0];
        let crop = InkRect {
            x: 0.0,
            y: 0.0,
            width: page.width,
            height: page.height,
        };
        let render_id = format!("trusted-render-{}", nanoid::nanoid!(8));
        let conn = db.get_conn_safe().expect("VFS connection");
        VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: render_id.clone(),
                render_id: render_id.clone(),
                document_id: manifest.document_id.clone(),
                page_id: page.page_id.clone(),
                revision: manifest.revision.clone(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: Some(crop),
                width_px: 1,
                height_px: 1,
            },
            TEST_PNG,
        )
        .expect("publish an immutable PNG artifact from the test's trusted render setup");
        (manifest, render_id)
    }

    fn with_parent_identity(
        db: Arc<crate::vfs::VfsDatabase>,
        block_id: &str,
        call_id: &str,
    ) -> ExecutionContext {
        context(db, block_id).with_tool_call_id(call_id)
    }

    fn page_snapshot(
        db: &crate::vfs::VfsDatabase,
        manifest: &crate::vfs::ink::InkManifest,
    ) -> crate::vfs::ink::InkPage {
        ink_commands::get_page(
            db,
            InkGetPageRequest {
                document_id: manifest.document_id.clone(),
                page_id: manifest.pages[0].page_id.clone(),
            },
        )
        .expect("load persisted VFS page")
    }

    #[test]
    fn handles_only_the_six_ink_tool_names_and_registry_routes_them() {
        let executor = Arc::new(InkToolExecutor::new());
        let names = [
            "ink_prepare",
            "ink_create",
            "ink_get",
            "ink_render",
            "ink_apply_ops",
            "ink_export",
        ];
        for name in names {
            assert!(executor.can_handle(name), "must handle {name}");
            assert!(executor.can_handle(&format!("builtin-{name}")));
        }
        assert!(!executor.can_handle("xink_create"));
        assert!(!executor.can_handle("mcp_ink_create"));
        assert!(!executor.can_handle("builtin-mcp_ink_create"));

        let registry = ToolExecutorRegistry::from_vec(vec![executor.clone()]);
        assert_eq!(
            registry
                .get_executor("builtin-ink_create")
                .map(|executor| executor.name()),
            Some("InkToolExecutor")
        );
        assert!(executor.has_dynamic_sensitivity("ink_apply_ops"));
        assert_eq!(
            executor.sensitivity_level_for_call(
                "builtin-ink_apply_ops",
                &json!({"ops":[{"op":"update_object"}]}),
            ),
            ToolSensitivity::High
        );
        assert_eq!(
            executor
                .sensitivity_level_for_call("ink_apply_ops", &json!({"ops":[{"op":"add_text"}]}),),
            ToolSensitivity::Medium
        );
    }

    #[tokio::test]
    async fn ink_render_without_a_frontend_fails_closed() {
        let (_temp, db) = setup_migrated_test_db();
        let result = InkToolExecutor::new()
            .execute(
                &call(
                    "builtin-ink_render",
                    json!({"document_id":"doc-test","expected_revision":"r-1","page_id":"page-1"}),
                ),
                &context(Arc::new(db), "ink-render-no-frontend"),
            )
            .await
            .expect("unavailable UI dependency is a normal tool failure");
        assert!(!result.success);
        assert_eq!(result.output["code"], "JOB_UNAVAILABLE");
        assert_eq!(result.output["retryable"], true);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn creates_and_reads_a_real_vfs_manifest_with_bounded_summary() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let executor = InkToolExecutor::new();
        let create_ctx = context(db.clone(), "ink-create-block");
        let created = executor
            .execute(
                &call(
                    "builtin-ink_create",
                    json!({"title":"Executor test","operation_id":"create-test-op"}),
                ),
                &create_ctx,
            )
            .await
            .expect("create should return a tool result");
        assert!(created.success, "create failed: {:?}", created.output);
        let repeated = executor
            .execute(
                &call(
                    "builtin-ink_create",
                    json!({"title":"Executor test","operation_id":"create-test-op"}),
                ),
                &create_ctx,
            )
            .await
            .expect("same context-bound operation should be replayable");
        assert!(repeated.success, "replay failed: {:?}", repeated.output);
        assert_eq!(
            repeated.output["document_id"],
            created.output["document_id"]
        );
        assert_eq!(
            repeated.output["operation_id"],
            created.output["operation_id"]
        );
        let reused = executor
            .execute(
                &call(
                    "builtin-ink_create",
                    json!({"title":"Different title","operation_id":"create-test-op"}),
                ),
                &create_ctx,
            )
            .await
            .expect("operation reuse is a normal tool failure");
        assert!(!reused.success);
        assert_eq!(reused.output["code"], "INVALID_ARGUMENT");
        let document_id = created.output["document_id"]
            .as_str()
            .expect("create output must contain the VFS document ID")
            .to_string();
        assert_eq!(created.output["pages"][0]["width"], 794.0);
        assert_eq!(created.output["pages"][0]["height"], 1123.0);

        let fetched = executor
            .execute(
                &call(
                    "ink_get",
                    json!({
                        "document_id": document_id,
                        "page_id": created.output["pages"][0]["page_id"],
                        "operation_id": created.output["operation_id"],
                    }),
                ),
                &context(db, "ink-get-block"),
            )
            .await
            .expect("get should return a tool result");
        assert!(fetched.success, "get failed: {:?}", fetched.output);
        assert_eq!(fetched.output["document_id"], created.output["document_id"]);
        assert_eq!(fetched.output["revision"], created.output["revision"]);
        assert_eq!(fetched.output["title"], "Executor test");
        assert_eq!(fetched.output["summary"]["page_count"], 1);
        assert_eq!(fetched.output["summary"]["object_count"], 0);
        assert_eq!(fetched.output["operation_status"], "succeeded");
        assert!(fetched.output.get("objects").is_none());
    }

    #[tokio::test]
    async fn create_client_operation_id_replays_across_tool_call_attempts_in_one_session() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let executor = InkToolExecutor::new();
        let first = executor
            .execute(
                &call(
                    "ink_create",
                    json!({"title":"Retry-safe create","operation_id":"stable-client-op"}),
                ),
                &context(db.clone(), "create-attempt-one").with_tool_call_id("call-one"),
            )
            .await
            .expect("first create result");
        assert!(first.success, "first create failed: {:?}", first.output);

        let retry = executor
            .execute(
                &call(
                    "ink_create",
                    json!({"title":"Retry-safe create","operation_id":"stable-client-op"}),
                ),
                &context(db, "create-attempt-two").with_tool_call_id("call-two"),
            )
            .await
            .expect("retry create result");
        assert!(retry.success, "retry create failed: {:?}", retry.output);
        assert_eq!(retry.output["document_id"], first.output["document_id"]);
    }

    #[tokio::test]
    async fn get_bounds_objects_and_replaces_stroke_samples_with_counts() {
        use crate::vfs::ink::{
            InkAuthor, InkObject, InkObjectContent, InkRect, InkSample, InkStrokeStyle, InkTool,
        };
        use crate::vfs::ink_commands::{self, InkSavePageRequest};

        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let executor = InkToolExecutor::new();
        let created = executor
            .execute(
                &call(
                    "ink_create",
                    json!({"title":"Summary test","operation_id":"summary-op"}),
                ),
                &context(db.clone(), "ink-summary-create"),
            )
            .await
            .expect("create result");
        assert!(created.success, "create failed: {:?}", created.output);
        let document_id = created.output["document_id"].as_str().unwrap();
        let revision = created.output["revision"].as_str().unwrap();
        let page_id = created.output["pages"][0]["page_id"].as_str().unwrap();
        ink_commands::save_page(
            &db,
            InkSavePageRequest {
                document_id: document_id.to_owned(),
                expected_revision: revision.to_owned(),
                operation_id: "summary-save-op".to_owned(),
                page: crate::vfs::ink::InkPage {
                    schema_version: crate::vfs::ink::INK_SCHEMA_VERSION,
                    page_id: page_id.to_owned(),
                    objects: vec![
                        InkObject {
                            id: "stroke-test".to_owned(),
                            author: InkAuthor::Ai,
                            created_at: 1,
                            content: InkObjectContent::Stroke {
                                samples: vec![
                                    InkSample {
                                        x: 1.0,
                                        y: 2.0,
                                        pressure: 0.5,
                                        elapsed_ms: None,
                                    },
                                    InkSample {
                                        x: 2.0,
                                        y: 3.0,
                                        pressure: 0.6,
                                        elapsed_ms: None,
                                    },
                                ],
                                style: InkStrokeStyle {
                                    tool: InkTool::Pen,
                                    color: "#000000".to_owned(),
                                    width: 1.0,
                                    pressure_enabled: false,
                                },
                            },
                        },
                        InkObject {
                            id: "text-test".to_owned(),
                            author: InkAuthor::Ai,
                            created_at: 2,
                            content: InkObjectContent::Text {
                                rect: InkRect {
                                    x: 10.0,
                                    y: 10.0,
                                    width: 20.0,
                                    height: 10.0,
                                },
                                text: "summary only".to_owned(),
                                font_size: 12.0,
                                color: "#000000".to_owned(),
                            },
                        },
                    ],
                },
            },
        )
        .expect("persist the real page through shared Ink VFS service");

        let fetched = executor
            .execute(
                &call(
                    "ink_get",
                    json!({"document_id":document_id,"page_id":page_id,"object_limit":1}),
                ),
                &context(db, "ink-summary-get"),
            )
            .await
            .expect("get result");
        assert!(fetched.success, "get failed: {:?}", fetched.output);
        assert_eq!(fetched.output["page"]["total_objects"], 2);
        assert_eq!(
            fetched.output["page"]["objects"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            fetched.output["page"]["objects"][0]["content"]["sample_count"],
            2
        );
        assert!(fetched.output["page"]["objects"][0]["content"]
            .get("samples")
            .is_none());
        assert_eq!(fetched.output["page"]["truncated"], true);
    }

    #[tokio::test]
    async fn apply_ops_creates_ai_objects_and_returns_a_bounded_receipt() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let call = apply_call(
            &manifest.document_id,
            &manifest.revision,
            "apply-ops-success",
            add_text_ops(&page_id, &render_id),
        );
        let ctx = with_parent_identity(db.clone(), "ink-apply-success", "ink-call");
        let chat_db = ctx.chat_v2_db.clone().expect("migrated Chat V2 fixture DB");
        let result = InkToolExecutor::new()
            .execute(&call, &ctx)
            .await
            .expect("apply_ops returns a tool result");
        assert!(result.success, "apply failed: {:?}", result.output);
        assert_eq!(result.output["document_id"], manifest.document_id);
        assert_ne!(result.output["revision"], manifest.revision);
        assert!(result.output["operation_id"]
            .as_str()
            .is_some_and(|operation_id| operation_id.starts_with("agent-")));
        assert_eq!(result.output["status"], "committed");
        assert_eq!(result.output["affected_page_ids"][0], page_id);
        assert!(result.output.get("ops").is_none());
        assert!(result.output.get("objects").is_none());
        assert!(result.output.get("pages").is_none());

        let persisted = page_snapshot(&db, &manifest);
        assert_eq!(persisted.objects.len(), 2);
        let stored_receipt = super::load_undo_receipt(
            &chat_db,
            "ink-executor-test-session",
            &result.output["operation_id"].as_str().unwrap(),
        )
        .expect("query durable apply receipt")
        .expect("successful apply stores a durable receipt");
        assert!(stored_receipt.committed);
        assert_eq!(
            stored_receipt.result_revision.as_deref(),
            result.output["revision"].as_str()
        );
        assert_eq!(stored_receipt.object_changes.len(), 2);
        assert!(persisted
            .objects
            .iter()
            .all(|object| { object.author == crate::vfs::ink::InkAuthor::Ai }));
        assert!(matches!(
            &persisted.objects[0].content,
            crate::vfs::ink::InkObjectContent::Text { text, .. } if text == "ordered first"
        ));
        assert!(matches!(
            &persisted.objects[1].content,
            crate::vfs::ink::InkObjectContent::Arrow { .. }
        ));
    }

    #[tokio::test]
    async fn apply_ops_accepts_100_ordered_operations() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let ops = Value::Array(
            (0..100)
                .map(|index| {
                    json!({
                        "op":"add_text",
                        "page_id":page_id,
                        "coordinate_space":"page",
                        "based_on_render_id":render_id,
                        "rect":{"x":0.1,"y":0.1,"width":0.4,"height":0.1},
                        "text":format!("ordered-{index}"),
                        "font_size":16,
                        "color":"#1f2937"
                    })
                })
                .collect(),
        );
        let result = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "apply-one-hundred",
                    ops,
                ),
                &with_parent_identity(db.clone(), "ink-apply-one-hundred", "parent-render-call"),
            )
            .await
            .expect("100-operation batch result");
        assert!(result.success, "100 operations failed: {:?}", result.output);
        let persisted = page_snapshot(&db, &manifest);
        assert_eq!(persisted.objects.len(), 100);
        assert!(matches!(
            &persisted.objects[0].content,
            crate::vfs::ink::InkObjectContent::Text { text, .. } if text == "ordered-0"
        ));
        assert!(matches!(
            &persisted.objects[99].content,
            crate::vfs::ink::InkObjectContent::Text { text, .. } if text == "ordered-99"
        ));
    }

    #[tokio::test]
    async fn apply_ops_exact_retry_is_idempotent_and_conflicting_input_is_rejected() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let ops = add_text_ops(&page_id, &render_id);
        let ctx = with_parent_identity(db.clone(), "ink-apply-retry", "parent-render-call");
        let first = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "apply-retry",
                    ops.clone(),
                ),
                &ctx,
            )
            .await
            .expect("first apply result");
        assert!(first.success, "first apply failed: {:?}", first.output);
        let revision = first.output["revision"].as_str().unwrap().to_owned();
        let retry = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "apply-retry",
                    ops.clone(),
                ),
                &ctx,
            )
            .await
            .expect("retry result");
        assert!(retry.success, "exact retry failed: {:?}", retry.output);
        assert_eq!(retry.output["revision"], revision);
        assert_eq!(page_snapshot(&db, &manifest).objects.len(), 2);

        let mut conflicting = ops;
        conflicting[0]["text"] = json!("different payload");
        let rejected = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "apply-retry",
                    conflicting,
                ),
                &ctx,
            )
            .await
            .expect("conflicting reuse result");
        assert!(!rejected.success);
        assert_eq!(rejected.output["code"], "INVALID_ARGUMENT");
        assert_eq!(page_snapshot(&db, &manifest).objects.len(), 2);
    }

    #[tokio::test]
    async fn cross_call_apply_retry_keeps_an_authoritative_undo_binding() {
        use crate::chat_v2::{repo::ChatV2Repo, types::ChatMessage};

        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let operations = add_text_ops(&page_id, &render_id);
        let client_operation_id = "cross-call-undo-binding";
        let first_call = apply_call(
            &manifest.document_id,
            &manifest.revision,
            client_operation_id,
            operations.clone(),
        );
        let first_ctx = context(db.clone(), "ink-first-attempt-block");
        let first = InkToolExecutor::new()
            .execute(&first_call, &first_ctx)
            .await
            .expect("first apply result");
        assert!(first.success, "first apply failed: {:?}", first.output);
        assert_eq!(page_snapshot(&db, &manifest).objects.len(), 2);
        let chat_db = first_ctx.chat_v2_db.as_ref().unwrap().clone();

        let retry_message = ChatMessage::new_assistant(first_ctx.session_id.clone());
        ChatV2Repo::create_message_v2(&chat_db, &retry_message).expect("persist retry message");
        let retry_call_id = "ink-call-retry-attempt-two";
        let mut retry_call = apply_call(
            &manifest.document_id,
            &manifest.revision,
            client_operation_id,
            operations,
        );
        retry_call.id = retry_call_id.to_owned();
        let retry_block_id = "ink-retry-attempt-two-block";
        let emitter = Arc::new(ChatV2EventEmitter::new_windowless_for_test(
            first_ctx.session_id.clone(),
        ));
        let mut retry_ctx = ExecutionContext::new(
            first_ctx.session_id.clone(),
            retry_message.id.clone(),
            retry_block_id.to_owned(),
            emitter,
            Arc::new(ToolRegistry::new()),
            None,
        )
        .with_tool_call_id(retry_call_id);
        retry_ctx.vfs_db = Some(db.clone());
        retry_ctx.chat_v2_db = Some(chat_db.clone());
        let retry = InkToolExecutor::new()
            .execute(&retry_call, &retry_ctx)
            .await
            .expect("retry result");
        assert!(retry.success, "retry failed: {:?}", retry.output);
        assert_eq!(retry.output["revision"], first.output["revision"]);
        assert_eq!(
            page_snapshot(&db, &manifest).objects.len(),
            2,
            "retry must not duplicate objects"
        );

        let conn = chat_db.get_conn_safe().expect("Chat V2 connection");
        let (retry_raw, retry_output): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT ink_undo_json,tool_output_json FROM chat_v2_blocks WHERE id=?1",
                [retry_block_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("persist retry tool block");
        let retry_output: Value =
            serde_json::from_str(retry_output.as_deref().expect("retry output persisted"))
                .expect("retry output JSON");
        let receipt_is_bound_to_retry_block = retry_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|receipt| {
                receipt["session_id"] == first_ctx.session_id
                    && receipt["message_id"] == retry_message.id
                    && receipt["block_id"] == retry_block_id
                    && receipt["operation_id"] == first.output["operation_id"]
                    && receipt["committed"] == true
            });
        let retry_links_original_receipt = retry_output["undo_available"] == false
            && retry_output["undo_receipt_message_id"] == first_ctx.message_id
            && retry_output["undo_receipt_block_id"] == first_ctx.block_id;
        assert!(receipt_is_bound_to_retry_block || retry_links_original_receipt,
            "a cross-call retry must either persist a receipt bound to its own Chat block or explicitly link the authoritative original receipt");
    }

    #[tokio::test]
    async fn apply_ops_rejects_missing_stale_render_and_stale_revision_without_writes() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let before = page_snapshot(&db, &manifest);

        let missing = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "missing-render-op",
                    add_text_ops(&page_id, "not-a-published-render"),
                ),
                &with_parent_identity(db.clone(), "ink-missing-render", "parent-render-call"),
            )
            .await
            .expect("missing render result");
        assert!(!missing.success);
        assert_ne!(missing.output["code"], "UNIMPLEMENTED");
        assert_eq!(page_snapshot(&db, &manifest), before);

        let stale_render_id = format!("stale-render-{}", nanoid::nanoid!(8));
        let current_crop = InkRect {
            x: 0.0,
            y: 0.0,
            width: manifest.pages[0].width,
            height: manifest.pages[0].height,
        };
        let conn = db.get_conn_safe().expect("VFS connection");
        VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: stale_render_id.clone(),
                render_id: stale_render_id.clone(),
                document_id: manifest.document_id.clone(),
                page_id: page_id.clone(),
                revision: "obsolete-revision".to_string(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: Some(current_crop),
                width_px: 1,
                height_px: 1,
            },
            TEST_PNG,
        )
        .expect("store real immutable artifact bound to obsolete revision");
        drop(conn);
        let stale = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "stale-render-op",
                    add_text_ops(&page_id, &stale_render_id),
                ),
                &with_parent_identity(db.clone(), "ink-stale-render", "parent-render-call"),
            )
            .await
            .expect("stale render result");
        assert!(!stale.success);
        assert!(stale.output["code"].is_string());
        assert_eq!(page_snapshot(&db, &manifest), before);

        ink_commands::rename(
            &db,
            InkRenameRequest {
                document_id: manifest.document_id.clone(),
                expected_revision: manifest.revision.clone(),
                operation_id: "external-cas-rename".to_string(),
                title: "Advanced revision".to_string(),
            },
        )
        .expect("advance actual VFS document revision");
        let stale_cas = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "stale-cas-op",
                    add_text_ops(&page_id, &render_id),
                ),
                &with_parent_identity(db.clone(), "ink-stale-cas", "parent-render-call"),
            )
            .await
            .expect("stale CAS result");
        assert!(!stale_cas.success);
        let current = ink_commands::get(
            &db,
            crate::vfs::ink_commands::InkGetRequest {
                document_id: manifest.document_id.clone(),
            },
        )
        .expect("reload current manifest");
        assert_eq!(page_snapshot(&db, &current).objects.len(), 0);
    }

    #[tokio::test]
    async fn apply_ops_cancelled_before_write_leaves_vfs_unchanged() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let before = page_snapshot(&db, &manifest);
        let token = CancellationToken::new();
        token.cancel();
        let result = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "cancelled-apply-op",
                    add_text_ops(&page_id, &render_id),
                ),
                &with_parent_identity(db.clone(), "ink-cancelled-apply", "parent-render-call")
                    .with_cancellation_token(token),
            )
            .await
            .expect("cancelled apply result");
        assert!(!result.success);
        assert_eq!(result.output["code"], "CANCELLED");
        assert_eq!(page_snapshot(&db, &manifest), before);
    }

    #[tokio::test]
    async fn apply_ops_rejects_unknown_fields_model_ids_and_batches_over_100() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let base_op = add_text_ops(&page_id, &render_id)[0].clone();
        let mut with_author = base_op.clone();
        with_author["author"] = json!("user");
        let mut with_id = base_op.clone();
        with_id["object_id"] = json!("caller-chosen-id");
        let mut with_timestamp = base_op.clone();
        with_timestamp["created_at"] = json!(1);
        let mut with_unknown = base_op.clone();
        with_unknown["surprise"] = json!(true);
        let mut too_many = Vec::new();
        for _ in 0..101 {
            too_many.push(base_op.clone());
        }

        for (label, ops) in [
            ("author", json!([with_author])),
            ("object ID", json!([with_id])),
            ("timestamp", json!([with_timestamp])),
            ("unknown field", json!([with_unknown])),
            ("batch > 100", Value::Array(too_many)),
        ] {
            let result = InkToolExecutor::new()
                .execute(
                    &apply_call(
                        &manifest.document_id,
                        &manifest.revision,
                        &format!("reject-{label}"),
                        ops,
                    ),
                    &with_parent_identity(
                        db.clone(),
                        &format!("ink-reject-{label}"),
                        "parent-render-call",
                    ),
                )
                .await
                .expect("invalid apply is a tool failure");
            assert!(!result.success, "{label} must be refused");
            assert_eq!(result.output["code"], "INVALID_ARGUMENT", "{label}");
        }
        assert_eq!(page_snapshot(&db, &manifest).objects.len(), 0);
    }

    #[tokio::test]
    async fn persisted_ink_render_reference_survives_generic_tool_block_upsert() {
        use crate::chat_v2::{
            database::ChatV2Database,
            repo::ChatV2Repo,
            types::{ChatMessage, ChatSession},
        };
        use crate::data_governance::{
            migration::coordinator::MigrationCoordinator, schema_registry::DatabaseId,
        };

        let (_vfs_dir, vfs_db) = setup_migrated_test_db();
        let vfs_db = Arc::new(vfs_db);
        let manifest = ink_commands::create(
            &vfs_db,
            InkCreateRequest {
                title: "Render reference fixture".to_owned(),
                ruling: InkRuling::Blank,
                width: 794.0,
                height: 1123.0,
                operation_id: format!("render-ref-create-{}", nanoid::nanoid!(8)),
                folder_id: None,
            },
        )
        .expect("create canonical VFS document");
        let render_id = format!("render-ref-{}", nanoid::nanoid!(8));
        let page = &manifest.pages[0];
        let conn = vfs_db.get_conn_safe().expect("VFS connection");
        let artifact = VfsInkArtifactRepo::store_png_with_conn(
            &conn,
            vfs_db.blobs_dir(),
            InkArtifactDraft {
                artifact_id: render_id.clone(),
                render_id: render_id.clone(),
                document_id: manifest.document_id.clone(),
                page_id: page.page_id.clone(),
                revision: manifest.revision.clone(),
                source_hash: None,
                source_annotation_revision: None,
                conversion_revision: None,
                crop: None,
                width_px: 1,
                height_px: 1,
            },
            TEST_PNG,
        )
        .expect("persist real immutable test render");
        drop(conn);

        let chat_dir = tempfile::TempDir::new().expect("Chat V2 temp directory");
        MigrationCoordinator::new(chat_dir.path().to_path_buf())
            .with_audit_db(None)
            .migrate_single(DatabaseId::ChatV2)
            .expect("migrate Chat V2 test database");
        let chat_db = ChatV2Database::new(chat_dir.path()).expect("open migrated Chat V2 database");
        let session = ChatSession::new("ink-render-ref-session".to_owned(), "chat".to_owned());
        ChatV2Repo::create_session_v2(&chat_db, &session).expect("save session");
        let message = ChatMessage::new_assistant(session.id.clone());
        ChatV2Repo::create_message_v2(&chat_db, &message).expect("save message");
        let block_id = "blk-ink-render-ref";
        let call_id = "call-ink-render-ref";
        let call = ToolCall::new(
            call_id.to_owned(),
            "builtin-ink_render".to_owned(),
            json!({"document_id":manifest.document_id}),
        );
        let mut ctx = context(vfs_db.clone(), block_id).with_tool_call_id(call_id);
        ctx.message_id = message.id.clone();
        ctx.session_id = session.id.clone();
        ctx.chat_v2_db = Some(Arc::new(chat_db));
        let reference = super::persist_render_artifact_ref(&ctx, &call, &artifact)
            .expect("persist produced trusted typed artifact reference");
        let generic_result = crate::chat_v2::types::ToolResultInfo::success(
            Some(call_id.to_owned()),
            Some(block_id.to_owned()),
            "builtin-ink_render".to_owned(),
            json!({"document_id":manifest.document_id}),
            json!({"status":"rendered"}),
            1,
        );
        ctx.save_tool_block(&generic_result)
            .expect("generic tool upsert");
        let persisted = ctx.chat_v2_db.as_ref().unwrap();
        let block = ChatV2Repo::get_block_v2(persisted, block_id)
            .expect("load persisted tool block")
            .expect("tool block exists");
        assert_eq!(block.ink_artifacts, vec![reference]);
        let (verified, _) = VfsInkArtifactRepo::load_for_document_with_conn(
            &vfs_db.get_conn_safe().unwrap(),
            vfs_db.blobs_dir(),
            &render_id,
            &manifest.document_id,
            &manifest.revision,
        )
        .expect("reference resolves to verified VFS artifact");
        assert_eq!(verified.content_hash, artifact.content_hash);
    }

    fn undo_receipt_fixture(
        session_id: &str,
        message_id: &str,
        block_id: &str,
        tool_call_id: &str,
        operation_id: &str,
    ) -> super::InkUndoReceipt {
        let args = InkApplyArgs {
            document_id: "receipt-document".to_owned(),
            expected_revision: "revision-before".to_owned(),
            operation_id: "client-receipt-operation".to_owned(),
            ops: vec![json!({"op":"append_blank_page","width":794,"height":1123,"ruling":"blank"})],
        };
        super::InkUndoReceipt {
            schema_version: super::INK_UNDO_SCHEMA_VERSION,
            session_id: session_id.to_owned(),
            message_id: message_id.to_owned(),
            block_id: block_id.to_owned(),
            tool_call_id: "receipt-call".to_owned(),
            document_id: args.document_id.clone(),
            operation_id: operation_id.to_owned(),
            input_hash: public_apply_input_hash(&args).expect("valid test public input hash"),
            created_at: 1_800_000_000_000,
            previous_revision: args.expected_revision,
            result_revision: None,
            vfs_input_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            object_changes: vec![],
            appended_page_ids: vec![],
            committed: false,
        }
    }

    #[test]
    fn load_undo_receipt_requires_matching_actual_parent_and_tool() {
        use crate::chat_v2::{
            repo::ChatV2Repo,
            types::{ChatMessage, ChatSession},
        };
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let ctx = context(Arc::new(vfs_db), "receipt-query-block");
        let chat_db = ctx.chat_v2_db.as_ref().unwrap();
        let trusted_session = ctx.session_id.clone();
        let trusted_message = ctx.message_id.clone();
        let foreign_session =
            ChatSession::new("ink-receipt-foreign-session".to_owned(), "chat".to_owned());
        ChatV2Repo::create_session_v2(chat_db, &foreign_session).expect("persist foreign session");
        let mut foreign_message = ChatMessage::new_assistant(foreign_session.id.clone());
        foreign_message.id = "ink-receipt-foreign-message".to_owned();
        ChatV2Repo::create_message_v2(chat_db, &foreign_message).expect("persist foreign message");

        let parent_mismatch = undo_receipt_fixture(
            &trusted_session,
            &trusted_message,
            "receipt-parent-mismatch",
            "receipt-call",
            "op-parent-mismatch",
        );
        let tool_mismatch = undo_receipt_fixture(
            &trusted_session,
            &trusted_message,
            "receipt-tool-mismatch",
            "receipt-call",
            "op-tool-mismatch",
        );
        let conn = chat_db.get_conn_safe().expect("Chat connection");
        for (block_id, actual_message, actual_tool, receipt) in [
            (
                &parent_mismatch.block_id,
                foreign_message.id.as_str(),
                "builtin-ink_apply_ops",
                &parent_mismatch,
            ),
            (
                &tool_mismatch.block_id,
                trusted_message.as_str(),
                "builtin-ink_get",
                &tool_mismatch,
            ),
        ] {
            let apply_args = InkApplyArgs {
                document_id: receipt.document_id.clone(),
                expected_revision: receipt.previous_revision.clone(),
                operation_id: "client-receipt-operation".to_owned(),
                ops: vec![
                    json!({"op":"append_blank_page","width":794,"height":1123,"ruling":"blank"}),
                ],
            };
            let apply_input = json!({"document_id":apply_args.document_id,"expected_revision":apply_args.expected_revision,"operation_id":apply_args.operation_id,"ops":apply_args.ops});
            let actual_call_id = if actual_tool == "builtin-ink_apply_ops" {
                receipt.tool_call_id.clone()
            } else {
                "different-call".to_owned()
            };
            conn.execute(
                "INSERT INTO chat_v2_blocks (id,message_id,block_type,status,tool_name,tool_call_id,tool_input_json,ink_undo_json) VALUES (?1,?2,'mcp_tool','running',?3,?4,?5,?6)",
                rusqlite::params![block_id, actual_message, actual_tool, actual_call_id, serde_json::to_string(&apply_input).unwrap(), serde_json::to_string(receipt).unwrap()],
            ).expect("store forged receipt row under mismatched trusted identity");
            let loaded = super::load_undo_receipt(chat_db, &trusted_session, &receipt.operation_id);
            assert!(
                loaded.as_ref().map_or(true, Option::is_none),
                "untrusted actual parent/tool metadata must not serve an embedded receipt"
            );
            let loaded_by_block = super::load_undo_receipt_for_block(
                chat_db,
                &trusted_session,
                actual_message,
                block_id,
            )
            .expect("block lookup should report a well-formed database result");
            assert!(
                loaded_by_block.is_none(),
                "trusted block lookup must validate actual message session and tool name"
            );
        }
    }

    #[test]
    fn save_undo_receipt_refuses_to_overwrite_block_with_mismatched_parent_or_tool() {
        use crate::chat_v2::{
            repo::ChatV2Repo,
            types::{ChatMessage, ChatSession},
        };
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let ctx = context(Arc::new(vfs_db), "receipt-write-block");
        let chat_db = ctx.chat_v2_db.as_ref().unwrap();
        let foreign_session = ChatSession::new(
            "ink-receipt-write-foreign-session".to_owned(),
            "chat".to_owned(),
        );
        ChatV2Repo::create_session_v2(chat_db, &foreign_session).expect("persist foreign session");
        let mut foreign_message = ChatMessage::new_assistant(foreign_session.id.clone());
        foreign_message.id = "ink-receipt-write-foreign-message".to_owned();
        ChatV2Repo::create_message_v2(chat_db, &foreign_message).expect("persist foreign message");

        for (index, actual_message, actual_tool) in [
            (
                "parent",
                foreign_message.id.as_str(),
                "builtin-ink_apply_ops",
            ),
            ("tool", ctx.message_id.as_str(), "builtin-ink_get"),
        ] {
            let block_id = format!("receipt-existing-{index}");
            let receipt = undo_receipt_fixture(
                &ctx.session_id,
                &ctx.message_id,
                &block_id,
                "receipt-call",
                &format!("op-existing-{index}"),
            );
            let apply_args = InkApplyArgs {
                document_id: receipt.document_id.clone(),
                expected_revision: receipt.previous_revision.clone(),
                operation_id: "client-receipt-operation".to_owned(),
                ops: vec![
                    json!({"op":"append_blank_page","width":794,"height":1123,"ruling":"blank"}),
                ],
            };
            let apply_input = json!({"document_id":apply_args.document_id,"expected_revision":apply_args.expected_revision,"operation_id":apply_args.operation_id,"ops":apply_args.ops});
            {
                let conn = chat_db.get_conn_safe().expect("Chat connection");
                conn.execute(
                    "INSERT INTO chat_v2_blocks (id,message_id,block_type,status,tool_name,tool_call_id,tool_input_json) VALUES (?1,?2,'mcp_tool','running',?3,?4,?5)",
                    rusqlite::params![block_id, actual_message, actual_tool, receipt.tool_call_id, serde_json::to_string(&apply_input).unwrap()],
                ).expect("insert pre-existing foreign tool block");
            }
            assert!(super::save_undo_receipt(chat_db, &receipt, &apply_input).is_err(),
                "must not overwrite an existing block whose actual parent/tool does not match the receipt");
            let conn = chat_db.get_conn_safe().expect("Chat connection");
            let stored: Option<String> = conn
                .query_row(
                    "SELECT ink_undo_json FROM chat_v2_blocks WHERE id=?1",
                    [&block_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                stored.is_none(),
                "foreign block must not acquire trusted undo metadata"
            );
        }
    }

    #[test]
    fn malformed_stored_undo_receipt_is_not_treated_as_absent() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let ctx = context(Arc::new(vfs_db), "receipt-malformed-block");
        let chat_db = ctx.chat_v2_db.as_ref().unwrap();
        {
            let conn = chat_db.get_conn_safe().expect("Chat connection");
            conn.execute(
                "INSERT INTO chat_v2_blocks (id,message_id,block_type,status,tool_name,ink_undo_json) VALUES (?1,?2,'mcp_tool','running','builtin-ink_apply_ops','{malformed')",
                rusqlite::params![ctx.block_id, ctx.message_id],
            ).expect("insert malformed receipt row");
        }
        let loaded = super::load_undo_receipt(chat_db, &ctx.session_id, "missing-operation");
        assert!(
            loaded.is_err(),
            "malformed receipt state must fail closed, not appear absent"
        );
        let by_block = super::load_undo_receipt_for_block(
            chat_db,
            &ctx.session_id,
            &ctx.message_id,
            &ctx.block_id,
        );
        assert!(
            by_block.is_err(),
            "malformed block receipt must not appear absent to undo callers"
        );
    }

    #[test]
    fn migrated_chat_undo_receipt_roundtrips_prepared_and_committed_payload() {
        let (_vfs_temp, vfs_db) = setup_migrated_test_db();
        let ctx = context(Arc::new(vfs_db), "block-undo-roundtrip");
        let chat_db = ctx.chat_v2_db.as_ref().unwrap();
        let args = InkApplyArgs {
            document_id: "receipt-document".to_owned(),
            expected_revision: "revision-before".to_owned(),
            operation_id: "client-receipt-operation".to_owned(),
            ops: vec![json!({"op":"append_blank_page","width":794,"height":1123,"ruling":"blank"})],
        };
        let input = json!({"document_id":args.document_id,"expected_revision":args.expected_revision,"operation_id":args.operation_id,"ops":args.ops});
        let mut receipt = undo_receipt_fixture(
            &ctx.session_id,
            &ctx.message_id,
            &ctx.block_id,
            "ink-call",
            "agent-undo",
        );
        super::save_undo_receipt(chat_db, &receipt, &input).expect("persist prepared receipt");
        let prepared = super::load_undo_receipt(chat_db, &ctx.session_id, "agent-undo")
            .expect("query prepared receipt")
            .expect("prepared receipt exists");
        assert_eq!(prepared, receipt);

        receipt.committed = true;
        receipt.result_revision = Some("r-2".to_owned());
        super::save_undo_receipt(chat_db, &receipt, &input).expect("promote committed receipt");
        let committed = super::load_undo_receipt(chat_db, &ctx.session_id, "agent-undo")
            .expect("query committed receipt")
            .expect("committed receipt exists");
        assert_eq!(committed, receipt);
    }

    #[test]
    fn registry_executor_config_keeps_commit_capable_ink_calls_self_managed() {
        let registry = ToolExecutorRegistry::from_vec(vec![Arc::new(InkToolExecutor::new())]);
        for tool in ["ink_apply_ops", "ink_prepare", "ink_export"] {
            let executor = registry
                .get_executor(tool)
                .expect("registered Ink executor");
            assert!(executor.manages_cancellation(tool),
                "ToolExecutorRegistry uses this flag before its generic cancellation select; {tool} must return its terminal commit state");
        }
    }

    #[tokio::test]
    async fn committed_apply_reports_terminal_block_persistence_failure() {
        let (_vfs_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let (manifest, render_id) = apply_fixture(&db);
        let page_id = manifest.pages[0].page_id.clone();
        let ctx = with_parent_identity(db.clone(), "ink-terminal-save-failure", "ink-call");
        let chat_db = ctx.chat_v2_db.as_ref().unwrap();
        {
            let conn = chat_db.get_conn_safe().expect("Chat V2 connection");
            conn.execute_batch(
                "CREATE TRIGGER fail_ink_terminal_tool_block BEFORE UPDATE ON chat_v2_blocks WHEN NEW.tool_name = 'builtin-ink_apply_ops' AND NEW.status = 'success' BEGIN SELECT RAISE(ABORT, 'injected terminal block persistence failure'); END;",
            ).expect("install terminal tool-block failure trigger");
        }
        let result = InkToolExecutor::new()
            .execute(
                &apply_call(
                    &manifest.document_id,
                    &manifest.revision,
                    "terminal-save-failure",
                    add_text_ops(&page_id, &render_id),
                ),
                &ctx,
            )
            .await
            .expect("tool persistence failure remains a structured tool result");
        assert!(
            !result.success,
            "durable output persistence failure must not claim successful delivery"
        );
        assert_eq!(
            result.output["status"], "committed",
            "the VFS commit must remain truthful"
        );
        assert_eq!(result.output["committed"], true);
        let persisted = page_snapshot(&db, &manifest);
        assert_eq!(
            persisted.objects.len(),
            2,
            "a terminal Chat-block failure cannot roll back the VFS commit"
        );
    }

    #[tokio::test]
    async fn cancelled_create_does_not_create_a_vfs_file() {
        let (_temp, db) = setup_migrated_test_db();
        let db = Arc::new(db);
        let before: i64 = db
            .get_conn_safe()
            .expect("VFS connection")
            .query_row(
                "SELECT COUNT(*) FROM files WHERE file_name LIKE '%.dsink'",
                [],
                |row| row.get(0),
            )
            .expect("count existing Ink files");
        let token = CancellationToken::new();
        token.cancel();
        let ctx = context(db.clone(), "ink-cancelled-create-block").with_cancellation_token(token);
        let result = InkToolExecutor::new()
            .execute(
                &call(
                    "ink_create",
                    json!({"title":"Must not exist","operation_id":"cancelled-create-op"}),
                ),
                &ctx,
            )
            .await
            .expect("cancellation should be returned as a normal tool result");
        assert!(!result.success);
        assert_eq!(result.output["code"], "CANCELLED");
        let after: i64 = db
            .get_conn_safe()
            .expect("VFS connection")
            .query_row(
                "SELECT COUNT(*) FROM files WHERE file_name LIKE '%.dsink'",
                [],
                |row| row.get(0),
            )
            .expect("count Ink files after cancellation");
        assert_eq!(after, before);
    }
}
