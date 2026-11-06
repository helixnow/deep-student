//! Board (`schema_version: 2`) operation planning.
//!
//! This module turns bounded AI operations into whole-chunk replacements. It
//! deliberately does not touch SQLite: the repository loads and verifies chunks,
//! verifies the render artifact owned by the document revision, then commits the
//! returned chunks atomically together with the operation receipt.

use std::collections::{BTreeMap, BTreeSet};

use super::{
    operations::{
        map_content_from_extent, map_point_from_extent, map_rect_from_extent, InkCoordinateSpace,
        InkObjectChange, InkOperation, InkOperationContent, InkOperationError,
        InkOperationErrorCode,
    },
    types::{
        InkAuthor, InkBoardChunk, InkBoardObject, InkManifest, InkObject, InkObjectContent,
        InkRect, INK_BOARD_SCHEMA_VERSION,
    },
    INK_BOARD_CHUNK_MAX_BYTES, INK_BOARD_CHUNK_OBJECTS_MAX, INK_BOARD_CHUNK_SAMPLES_MAX,
};

/// Whole-chunk changes planned for one board apply/undo.
pub(crate) struct BoardOperationPlan {
    pub(crate) changed_chunks: Vec<InkBoardChunk>,
    pub(crate) deleted_chunk_ids: Vec<String>,
    pub(crate) object_changes: Vec<InkObjectChange>,
    pub(crate) affected_page_ids: Vec<String>,
    pub(crate) appended_page_ids: Vec<String>,
}

fn operation_error(code: InkOperationErrorCode, message: &'static str) -> InkOperationError {
    InkOperationError {
        code,
        message: message.to_owned(),
    }
}

fn ink_object_from_board(object: &InkBoardObject) -> InkObject {
    InkObject {
        id: object.id.clone(),
        author: object.author,
        created_at: object.created_at,
        content: object.content.clone(),
    }
}

fn record_change(changes: &mut Vec<InkObjectChange>, change: InkObjectChange) {
    if let Some(existing) = changes.iter_mut().find(|existing| {
        existing.page_id == change.page_id && existing.object_id == change.object_id
    }) {
        existing.after = change.after;
        existing.z_index = change.z_index;
    } else {
        changes.push(change);
    }
}

fn require_surface_page(page_id: &str, surface_page_id: &str) -> Result<(), InkOperationError> {
    if page_id != surface_page_id {
        return Err(operation_error(
            InkOperationErrorCode::PageNotFound,
            "Ink board operation targets an unsupported page",
        ));
    }
    Ok(())
}

fn require_render_crop(
    space: InkCoordinateSpace,
    render_id: &str,
    crops: &BTreeMap<String, InkRect>,
) -> Result<InkRect, InkOperationError> {
    if space != InkCoordinateSpace::RenderCrop {
        return Err(operation_error(
            InkOperationErrorCode::GeometryInvalid,
            "Ink board operations require render_crop coordinates",
        ));
    }
    crops.get(render_id).copied().ok_or_else(|| {
        operation_error(
            InkOperationErrorCode::RenderMappingRequired,
            "A verified board render mapping is required",
        )
    })
}

fn unique_new_chunk_id(current: &BTreeMap<String, InkBoardChunk>) -> String {
    loop {
        let chunk_id = format!("c_{}", nanoid::nanoid!(12));
        if !current.contains_key(&chunk_id) {
            return chunk_id;
        }
    }
}

fn collect_plan(
    current: BTreeMap<String, InkBoardChunk>,
    original_chunk_ids: &BTreeSet<String>,
    changed_ids: BTreeSet<String>,
    object_changes: Vec<InkObjectChange>,
    affected_page_ids: Vec<String>,
) -> BoardOperationPlan {
    let mut changed_chunks = Vec::new();
    let mut deleted_chunk_ids = Vec::new();
    for chunk_id in changed_ids {
        let Some(chunk) = current.get(&chunk_id) else {
            continue;
        };
        if chunk.objects.is_empty() {
            // A brand-new chunk that ended empty has nothing to delete; only
            // pre-existing chunks become deletions.
            if original_chunk_ids.contains(&chunk_id) {
                deleted_chunk_ids.push(chunk_id);
            }
            continue;
        }
        changed_chunks.push(chunk.clone());
    }
    let mut object_changes = object_changes;
    object_changes.retain(|change| change.before != change.after);
    BoardOperationPlan {
        changed_chunks,
        deleted_chunk_ids,
        object_changes,
        affected_page_ids,
        appended_page_ids: Vec::new(),
    }
}

fn object_location(
    current: &BTreeMap<String, InkBoardChunk>,
    object_id: &str,
) -> Option<(String, usize)> {
    for (chunk_id, chunk) in current {
        if let Some(index) = chunk
            .objects
            .iter()
            .position(|object| object.id.as_str() == object_id)
        {
            return Some((chunk_id.clone(), index));
        }
    }
    None
}

fn next_z(max_z: Option<i64>) -> Result<i64, InkOperationError> {
    match max_z {
        Some(max_z) => max_z.checked_add(1).ok_or_else(|| {
            operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink board z-index budget is exhausted",
            )
        }),
        None => Ok(0),
    }
}

fn board_max_z(chunks: &[InkBoardChunk]) -> Option<i64> {
    chunks
        .iter()
        .flat_map(|chunk| chunk.objects.iter())
        .map(|object| object.z_index)
        .max()
}

fn object_sample_count(object: &InkBoardObject) -> usize {
    match &object.content {
        InkObjectContent::Stroke { samples, .. } => samples.len(),
        _ => 0,
    }
}

fn chunk_sample_count(chunk: &InkBoardChunk) -> usize {
    chunk
        .objects
        .iter()
        .map(object_sample_count)
        .fold(0usize, usize::saturating_add)
}

/// Return a whole replacement chunk when one more whole object still fits the
/// existing 8 MiB/object/sample budgets, otherwise `None`.
fn chunk_with_added_object(
    chunk: &InkBoardChunk,
    object: InkBoardObject,
) -> Result<Option<InkBoardChunk>, InkOperationError> {
    if chunk.objects.len() >= INK_BOARD_CHUNK_OBJECTS_MAX as usize {
        return Ok(None);
    }
    let samples = chunk_sample_count(chunk)
        .checked_add(object_sample_count(&object))
        .ok_or_else(|| {
            operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink board chunk sample budget is exhausted",
            )
        })?;
    if samples > INK_BOARD_CHUNK_SAMPLES_MAX as usize {
        return Ok(None);
    }
    let mut candidate = chunk.clone();
    candidate.objects.push(object);
    let bytes = serde_json::to_vec(&candidate).map_err(|_| {
        operation_error(
            InkOperationErrorCode::ContentInvalid,
            "Ink board chunk cannot be serialized",
        )
    })?;
    if bytes.len() > INK_BOARD_CHUNK_MAX_BYTES {
        return Ok(None);
    }
    Ok(Some(candidate))
}

/// Place one whole object into the first existing whole chunk with slack, or a
/// new chunk when every existing chunk is full. The replacement is always a
/// complete chunk, so prior human objects in that chunk are preserved.
///
/// This only mutates chunk content; callers own any receipt/change recording.
fn place_whole_object(
    current: &mut BTreeMap<String, InkBoardChunk>,
    changed_ids: &mut BTreeSet<String>,
    object: InkBoardObject,
) -> Result<(), InkOperationError> {
    let mut target = None;
    for (chunk_id, chunk) in current.iter() {
        if chunk_with_added_object(chunk, object.clone())?.is_some() {
            target = Some(chunk_id.clone());
            break;
        }
    }
    if let Some(chunk_id) = target {
        let chunk = current
            .get_mut(&chunk_id)
            .expect("first-fit chunk must exist");
        let replacement = chunk_with_added_object(chunk, object)?.ok_or_else(|| {
            operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink board chunk budget changed during planning",
            )
        })?;
        *chunk = replacement;
        changed_ids.insert(chunk_id);
        return Ok(());
    }
    let chunk_id = unique_new_chunk_id(current);
    let empty = InkBoardChunk {
        schema_version: INK_BOARD_SCHEMA_VERSION,
        chunk_id: chunk_id.clone(),
        objects: Vec::new(),
    };
    let chunk = chunk_with_added_object(&empty, object)?.ok_or_else(|| {
        operation_error(
            InkOperationErrorCode::ContentInvalid,
            "Ink board chunk budget is too small for one object",
        )
    })?;
    current.insert(chunk_id.clone(), chunk);
    changed_ids.insert(chunk_id);
    Ok(())
}

/// Place one whole AI object and record its apply change receipt.
fn append_added_object(
    current: &mut BTreeMap<String, InkBoardChunk>,
    changed_ids: &mut BTreeSet<String>,
    object: InkBoardObject,
    page_id: &str,
    changes: &mut Vec<InkObjectChange>,
) -> Result<(), InkOperationError> {
    record_change(
        changes,
        InkObjectChange {
            page_id: page_id.to_owned(),
            object_id: object.id.clone(),
            before: None,
            after: Some(ink_object_from_board(&object)),
            z_index: Some(object.z_index),
        },
    );
    place_whole_object(current, changed_ids, object)
}

/// Plan one bounded AI apply against validated board chunks.
pub(crate) fn plan_board_apply(
    manifest: &InkManifest,
    surface_page_id: &str,
    chunks: &[InkBoardChunk],
    operations: &[InkOperation],
    render_crops: &BTreeMap<String, InkRect>,
) -> Result<BoardOperationPlan, InkOperationError> {
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(operation_error(
            InkOperationErrorCode::ContentInvalid,
            "Ink board operations require a board document",
        ));
    }
    if operations.is_empty() || operations.len() > 100 {
        return Err(operation_error(
            InkOperationErrorCode::BatchSizeInvalid,
            "Ink operation batch must contain 1 to 100 operations",
        ));
    }

    let mut current = BTreeMap::new();
    for chunk in chunks {
        if current
            .insert(chunk.chunk_id.clone(), chunk.clone())
            .is_some()
        {
            return Err(operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink board chunk IDs are not unique",
            ));
        }
    }
    let original_chunk_ids: BTreeSet<String> = current.keys().cloned().collect();
    let mut next_z = next_z(board_max_z(chunks))?;
    let mut changed_ids = BTreeSet::new();
    let mut changes = Vec::new();

    for operation in operations {
        match operation {
            InkOperation::AppendBlankPage { .. } => {
                return Err(operation_error(
                    InkOperationErrorCode::ContentInvalid,
                    "Ink board documents do not support append_blank_page",
                ))
            }
            InkOperation::AddText {
                page_id,
                object_id,
                created_at,
                coordinate_space,
                based_on_render_id,
                rect,
                text,
                font_size,
                color,
            } => {
                require_surface_page(page_id, surface_page_id)?;
                let crop =
                    require_render_crop(*coordinate_space, based_on_render_id, render_crops)?;
                let content = InkObjectContent::Text {
                    rect: map_rect_from_extent(*rect, crop.x, crop.y, crop.width, crop.height)?,
                    text: text.clone(),
                    font_size: *font_size,
                    color: color.clone(),
                };
                append_added_object(
                    &mut current,
                    &mut changed_ids,
                    InkBoardObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        z_index: next_z,
                        content,
                    },
                    surface_page_id,
                    &mut changes,
                )?;
                next_z = next_z.checked_add(1).ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::ContentInvalid,
                        "Ink board z-index budget is exhausted",
                    )
                })?;
            }
            InkOperation::AddRect {
                page_id,
                object_id,
                created_at,
                coordinate_space,
                based_on_render_id,
                rect,
                color,
                width,
            }
            | InkOperation::AddEllipse {
                page_id,
                object_id,
                created_at,
                coordinate_space,
                based_on_render_id,
                rect,
                color,
                width,
            }
            | InkOperation::AddRegionHighlight {
                page_id,
                object_id,
                created_at,
                coordinate_space,
                based_on_render_id,
                rect,
                color,
                width,
            } => {
                require_surface_page(page_id, surface_page_id)?;
                let crop =
                    require_render_crop(*coordinate_space, based_on_render_id, render_crops)?;
                let rect = map_rect_from_extent(*rect, crop.x, crop.y, crop.width, crop.height)?;
                let content = match operation {
                    InkOperation::AddRect { .. } => InkObjectContent::Rect {
                        rect,
                        color: color.clone(),
                        width: *width,
                    },
                    InkOperation::AddEllipse { .. } => InkObjectContent::Ellipse {
                        rect,
                        color: color.clone(),
                        width: *width,
                    },
                    _ => InkObjectContent::RegionHighlight {
                        rect,
                        color: color.clone(),
                        width: *width,
                    },
                };
                append_added_object(
                    &mut current,
                    &mut changed_ids,
                    InkBoardObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        z_index: next_z,
                        content,
                    },
                    surface_page_id,
                    &mut changes,
                )?;
                next_z = next_z.checked_add(1).ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::ContentInvalid,
                        "Ink board z-index budget is exhausted",
                    )
                })?;
            }
            InkOperation::AddArrow {
                page_id,
                object_id,
                created_at,
                coordinate_space,
                based_on_render_id,
                from,
                to,
                color,
                width,
            } => {
                require_surface_page(page_id, surface_page_id)?;
                let crop =
                    require_render_crop(*coordinate_space, based_on_render_id, render_crops)?;
                let content = InkObjectContent::Arrow {
                    from: map_point_from_extent(*from, crop.x, crop.y, crop.width, crop.height)?,
                    to: map_point_from_extent(*to, crop.x, crop.y, crop.width, crop.height)?,
                    color: color.clone(),
                    width: *width,
                };
                append_added_object(
                    &mut current,
                    &mut changed_ids,
                    InkBoardObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        z_index: next_z,
                        content,
                    },
                    surface_page_id,
                    &mut changes,
                )?;
                next_z = next_z.checked_add(1).ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::ContentInvalid,
                        "Ink board z-index budget is exhausted",
                    )
                })?;
            }
            InkOperation::UpdateObject {
                page_id,
                object_id,
                coordinate_space,
                based_on_render_id,
                content,
            } => {
                require_surface_page(page_id, surface_page_id)?;
                let crop =
                    require_render_crop(*coordinate_space, based_on_render_id, render_crops)?;
                let (chunk_id, index) = object_location(&current, object_id).ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::ObjectNotFound,
                        "Ink object not found",
                    )
                })?;
                let chunk = current
                    .get_mut(&chunk_id)
                    .expect("located board chunk must exist");
                if matches!(
                    &chunk.objects[index].content,
                    InkObjectContent::Stroke { .. }
                ) {
                    return Err(operation_error(
                        InkOperationErrorCode::UnsupportedStrokeUpdate,
                        "Ink stroke objects cannot be replaced by tool operations",
                    ));
                }
                let z_index = chunk.objects[index].z_index;
                let before = ink_object_from_board(&chunk.objects[index]);
                let content = map_content_from_extent(
                    content.clone(),
                    crop.x,
                    crop.y,
                    crop.width,
                    crop.height,
                )?;
                chunk.objects[index].content = content;
                let after = ink_object_from_board(&chunk.objects[index]);
                changed_ids.insert(chunk_id);
                record_change(
                    &mut changes,
                    InkObjectChange {
                        page_id: surface_page_id.to_owned(),
                        object_id: object_id.clone(),
                        before: Some(before),
                        after: Some(after),
                        z_index: Some(z_index),
                    },
                );
            }
            InkOperation::RemoveObject { page_id, object_id } => {
                require_surface_page(page_id, surface_page_id)?;
                let (chunk_id, index) = object_location(&current, object_id).ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::ObjectNotFound,
                        "Ink object not found",
                    )
                })?;
                let chunk = current
                    .get_mut(&chunk_id)
                    .expect("located board chunk must exist");
                if matches!(
                    &chunk.objects[index].content,
                    InkObjectContent::Stroke { .. }
                ) {
                    return Err(operation_error(
                        InkOperationErrorCode::UnsupportedStrokeUpdate,
                        "Ink stroke objects cannot be removed by tool operations",
                    ));
                }
                let removed = chunk.objects.remove(index);
                let z_index = removed.z_index;
                let before = ink_object_from_board(&removed);
                changed_ids.insert(chunk_id);
                record_change(
                    &mut changes,
                    InkObjectChange {
                        page_id: surface_page_id.to_owned(),
                        object_id: object_id.clone(),
                        before: Some(before),
                        after: None,
                        z_index: Some(z_index),
                    },
                );
            }
        }
    }

    Ok(collect_plan(
        current,
        &original_chunk_ids,
        changed_ids,
        changes,
        vec![surface_page_id.to_owned()],
    ))
}

/// Plan a trusted board undo from repository-supplied before/after objects.
///
/// Objects are matched exactly (id, author, created_at, content) after ignoring
/// the storage-only `z_index`; unrelated later human objects are preserved.
/// Updates keep the current z position, and reinserts reuse whole-chunk slack
/// before adding a new chunk.
pub(crate) fn plan_board_undo(
    manifest: &InkManifest,
    surface_page_id: &str,
    chunks: &[InkBoardChunk],
    changes: &[InkObjectChange],
    appended_page_ids: &[String],
) -> Result<BoardOperationPlan, InkOperationError> {
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(operation_error(
            InkOperationErrorCode::ContentInvalid,
            "Ink board undo requires a board document",
        ));
    }
    if !appended_page_ids.is_empty() {
        return Err(operation_error(
            InkOperationErrorCode::RevisionConflict,
            "Ink board undo cannot remove appended pages",
        ));
    }

    let mut current = BTreeMap::new();
    for chunk in chunks {
        if current
            .insert(chunk.chunk_id.clone(), chunk.clone())
            .is_some()
        {
            return Err(operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink board chunk IDs are not unique",
            ));
        }
    }
    let original_chunk_ids: BTreeSet<String> = current.keys().cloned().collect();

    let mut changed_ids = BTreeSet::new();
    let mut seen = Vec::<(String, String)>::new();

    for change in changes {
        let key = (change.page_id.clone(), change.object_id.clone());
        if seen.contains(&key)
            || (change.before.is_none() && change.after.is_none())
            || change
                .before
                .as_ref()
                .is_some_and(|object| object.id != change.object_id)
            || change
                .after
                .as_ref()
                .is_some_and(|object| object.id != change.object_id)
        {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo change record is inconsistent",
            ));
        }
        seen.push(key);
        if change.page_id.as_str() != surface_page_id {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo target page no longer exists",
            ));
        }

        let location = object_location(&current, &change.object_id);
        let current_object = location.as_ref().map(|(chunk_id, index)| {
            ink_object_from_board(
                &current
                    .get(chunk_id)
                    .expect("located board chunk must exist")
                    .objects[*index],
            )
        });
        if current_object != change.after {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo target object changed after the AI operation",
            ));
        }
        if let Some((chunk_id, index)) = &location {
            let current_z = current
                .get(chunk_id)
                .expect("located board chunk must exist")
                .objects[*index]
                .z_index;
            if change.z_index != Some(current_z) {
                return Err(operation_error(
                    InkOperationErrorCode::RevisionConflict,
                    "Undo receipt z-index does not match the stored board object",
                ));
            }
        }

        match (&change.before, location) {
            (Some(before), Some((chunk_id, index))) => {
                let chunk = current
                    .get_mut(&chunk_id)
                    .expect("located board chunk must exist");
                let z_index = chunk.objects[index].z_index;
                chunk.objects[index] = InkBoardObject {
                    id: before.id.clone(),
                    author: before.author,
                    created_at: before.created_at,
                    z_index,
                    content: before.content.clone(),
                };
                changed_ids.insert(chunk_id);
            }
            (Some(before), None) => {
                let z_index = change.z_index.ok_or_else(|| {
                    operation_error(
                        InkOperationErrorCode::RevisionConflict,
                        "Undo receipt is missing the board z-index to restore",
                    )
                })?;
                if current
                    .values()
                    .flat_map(|chunk| chunk.objects.iter())
                    .any(|object| object.z_index == z_index)
                {
                    return Err(operation_error(
                        InkOperationErrorCode::RevisionConflict,
                        "Undo cannot restore a board z-index now owned by a later object",
                    ));
                }
                place_whole_object(
                    &mut current,
                    &mut changed_ids,
                    InkBoardObject {
                        id: before.id.clone(),
                        author: before.author,
                        created_at: before.created_at,
                        z_index,
                        content: before.content.clone(),
                    },
                )?;
            }
            (None, Some((chunk_id, index))) => {
                let chunk = current
                    .get_mut(&chunk_id)
                    .expect("located board chunk must exist");
                chunk.objects.remove(index);
                changed_ids.insert(chunk_id);
            }
            (None, None) => unreachable!("empty before/after changes were rejected"),
        }
    }

    let affected_page_ids = if changes.is_empty() {
        Vec::new()
    } else {
        vec![surface_page_id.to_owned()]
    };
    Ok(collect_plan(
        current,
        &original_chunk_ids,
        changed_ids,
        Vec::new(),
        affected_page_ids,
    ))
}
