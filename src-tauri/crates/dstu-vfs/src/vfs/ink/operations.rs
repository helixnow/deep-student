//! Pure, bounded page-operation contract.
//!
//! The document service loads ownership-checked render mappings and generates
//! object IDs/timestamps. Geometry inputs remain normalized until application.

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

fn present_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn take_field<E: serde::de::Error, T>(value: Option<T>) -> Result<T, E> {
    value.ok_or_else(|| E::custom("Invalid Ink operation"))
}

use super::{
    validate_manifest, validate_page, InkAuthor, InkBackground, InkManifest, InkObject,
    InkObjectContent, InkPage, InkPageRef, InkPoint, InkRect, InkRuling, INK_PAGES_MAX,
    INK_PAGE_OBJECTS_MAX, INK_SCHEMA_VERSION,
};

/// Coordinate space used by normalized tool geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkCoordinateSpace {
    Page,
    RenderCrop,
}

/// A normalized point in the selected page or render-crop coordinate space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct InkNormalizedPoint {
    pub x: f64,
    pub y: f64,
}

impl<'de> Deserialize<'de> for InkNormalizedPoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            x: f64,
            y: f64,
        }
        let fields = Fields::deserialize(deserializer)?;
        Ok(Self {
            x: fields.x,
            y: fields.y,
        })
    }
}

/// A normalized rectangle in the selected page or render-crop coordinate space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct InkNormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl<'de> Deserialize<'de> for InkNormalizedRect {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            x: f64,
            y: f64,
            width: f64,
            height: f64,
        }
        let fields = Fields::deserialize(deserializer)?;
        Ok(Self {
            x: fields.x,
            y: fields.y,
            width: fields.width,
            height: fields.height,
        })
    }
}

/// Frozen mapping loaded and ownership-checked by the document service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRenderMapping {
    pub render_id: String,
    pub document_id: String,
    pub revision: String,
    pub page_id: String,
    /// Logical page area represented by the render crop.
    pub crop: InkRect,
}

/// Controlled content for update operations; stroke content is intentionally absent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InkOperationContent {
    Text {
        rect: InkNormalizedRect,
        text: String,
        font_size: f64,
        color: String,
    },
    Rect {
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    Ellipse {
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    RegionHighlight {
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    Arrow {
        from: InkNormalizedPoint,
        to: InkNormalizedPoint,
        color: String,
        width: f64,
    },
}

impl<'de> Deserialize<'de> for InkOperationContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
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

        let fields = Fields::deserialize(deserializer)?;
        let present_count = [
            fields.rect.is_some(),
            fields.text.is_some(),
            fields.font_size.is_some(),
            fields.color.is_some(),
            fields.width.is_some(),
            fields.from.is_some(),
            fields.to.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count();
        let invalid = || <D::Error as serde::de::Error>::custom("Invalid Ink operation content");

        match fields.kind.as_str() {
            "text" if present_count == 4 => Ok(Self::Text {
                rect: take_field(fields.rect)?,
                text: take_field(fields.text)?,
                font_size: take_field(fields.font_size)?,
                color: take_field(fields.color)?,
            }),
            "rect" if present_count == 3 => Ok(Self::Rect {
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "ellipse" if present_count == 3 => Ok(Self::Ellipse {
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "region_highlight" if present_count == 3 => Ok(Self::RegionHighlight {
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "arrow" if present_count == 4 => Ok(Self::Arrow {
                from: take_field(fields.from)?,
                to: take_field(fields.to)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            _ => Err(invalid()),
        }
    }
}

/// One bounded operation. Addition IDs/timestamps are generated by the service.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkOperation {
    AppendBlankPage {
        /// Internal ID generated by the service (not accepted from a tool request).
        page_id: String,
        width: f64,
        height: f64,
        ruling: InkRuling,
    },
    AddText {
        page_id: String,
        object_id: String,
        created_at: i64,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        rect: InkNormalizedRect,
        text: String,
        font_size: f64,
        color: String,
    },
    AddRect {
        page_id: String,
        object_id: String,
        created_at: i64,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    AddEllipse {
        page_id: String,
        object_id: String,
        created_at: i64,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    AddArrow {
        page_id: String,
        object_id: String,
        created_at: i64,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        from: InkNormalizedPoint,
        to: InkNormalizedPoint,
        color: String,
        width: f64,
    },
    AddRegionHighlight {
        page_id: String,
        object_id: String,
        created_at: i64,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        rect: InkNormalizedRect,
        color: String,
        width: f64,
    },
    UpdateObject {
        page_id: String,
        object_id: String,
        coordinate_space: InkCoordinateSpace,
        based_on_render_id: String,
        content: InkOperationContent,
    },
    RemoveObject {
        page_id: String,
        object_id: String,
    },
}

impl<'de> Deserialize<'de> for InkOperation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            op: String,
            #[serde(default, deserialize_with = "present_non_null")]
            page_id: Option<String>,
            #[serde(default, deserialize_with = "present_non_null")]
            object_id: Option<String>,
            #[serde(default, deserialize_with = "present_non_null")]
            created_at: Option<i64>,
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
            content: Option<InkOperationContent>,
        }

        let fields = Fields::deserialize(deserializer)?;
        let present_count = [
            fields.page_id.is_some(),
            fields.object_id.is_some(),
            fields.created_at.is_some(),
            fields.coordinate_space.is_some(),
            fields.based_on_render_id.is_some(),
            fields.width.is_some(),
            fields.height.is_some(),
            fields.ruling.is_some(),
            fields.rect.is_some(),
            fields.text.is_some(),
            fields.font_size.is_some(),
            fields.color.is_some(),
            fields.from.is_some(),
            fields.to.is_some(),
            fields.content.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count();
        let invalid = || <D::Error as serde::de::Error>::custom("Invalid Ink operation");

        match fields.op.as_str() {
            "append_blank_page" if present_count == 4 => Ok(Self::AppendBlankPage {
                page_id: take_field(fields.page_id)?,
                width: take_field(fields.width)?,
                height: take_field(fields.height)?,
                ruling: take_field(fields.ruling)?,
            }),
            "add_text" if present_count == 9 => Ok(Self::AddText {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                created_at: take_field(fields.created_at)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                rect: take_field(fields.rect)?,
                text: take_field(fields.text)?,
                font_size: take_field(fields.font_size)?,
                color: take_field(fields.color)?,
            }),
            "add_rect" if present_count == 8 => Ok(Self::AddRect {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                created_at: take_field(fields.created_at)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "add_ellipse" if present_count == 8 => Ok(Self::AddEllipse {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                created_at: take_field(fields.created_at)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "add_region_highlight" if present_count == 8 => Ok(Self::AddRegionHighlight {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                created_at: take_field(fields.created_at)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                rect: take_field(fields.rect)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "add_arrow" if present_count == 9 => Ok(Self::AddArrow {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                created_at: take_field(fields.created_at)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                from: take_field(fields.from)?,
                to: take_field(fields.to)?,
                color: take_field(fields.color)?,
                width: take_field(fields.width)?,
            }),
            "update_object" if present_count == 5 => Ok(Self::UpdateObject {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
                coordinate_space: take_field(fields.coordinate_space)?,
                based_on_render_id: take_field(fields.based_on_render_id)?,
                content: take_field(fields.content)?,
            }),
            "remove_object" if present_count == 2 => Ok(Self::RemoveObject {
                page_id: take_field(fields.page_id)?,
                object_id: take_field(fields.object_id)?,
            }),
            _ => Err(invalid()),
        }
    }
}

/// Structured operation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InkOperationErrorCode {
    BatchSizeInvalid,
    PageNotFound,
    ObjectNotFound,
    DuplicateId,
    PageLimitExceeded,
    GeometryInvalid,
    ContentInvalid,
    RenderMappingRequired,
    RenderMappingMismatch,
    UnsupportedStrokeUpdate,
    RevisionConflict,
}

/// Operation error, kept separate from stable parse/storage error codes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("ink operation error [{code:?}]: {message}")]
pub struct InkOperationError {
    pub code: InkOperationErrorCode,
    pub message: String,
}

/// Before/after object values needed by a later object-scoped AI undo transaction.
#[derive(Debug, Clone, PartialEq)]
pub struct InkObjectChange {
    pub page_id: String,
    pub object_id: String,
    pub before: Option<InkObject>,
    pub after: Option<InkObject>,
    /// Board-only storage order. Paged documents always use `None`; a board
    /// receipt carries the trusted z-index so undo can restore the exact layer
    /// position without inventing a page or parsing object arrays again.
    pub z_index: Option<i64>,
}

/// New logical page state after applying an operation or undo batch.
#[derive(Debug, Clone, PartialEq)]
pub struct InkOperationsResult {
    pub manifest: InkManifest,
    pub pages: Vec<InkPage>,
    pub affected_page_ids: Vec<String>,
    pub object_changes: Vec<InkObjectChange>,
    pub appended_page_ids: Vec<String>,
}

/// Revert one AI change set without overwriting later unrelated user edits.
pub fn undo_operations(
    manifest: &InkManifest,
    pages: &[InkPage],
    changes: &[InkObjectChange],
    appended_page_ids: &[String],
) -> Result<InkOperationsResult, InkOperationError> {
    validate_manifest(manifest).map_err(|_| state_error())?;
    if pages.len() != manifest.pages.len() {
        return Err(state_error());
    }

    let mut next_manifest = manifest.clone();
    let mut next_pages = pages.to_vec();
    let mut affected_page_ids = Vec::new();
    let mut seen_change_ids = Vec::<(String, String)>::new();
    let mut seen_page_ids = Vec::<String>::new();

    for page_ref in &manifest.pages {
        if seen_page_ids
            .iter()
            .any(|page_id| page_id == &page_ref.page_id)
        {
            return Err(state_error());
        }
        seen_page_ids.push(page_ref.page_id.clone());
        let indices = next_pages
            .iter()
            .enumerate()
            .filter(|(_, page)| page.page_id == page_ref.page_id)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if indices.len() != 1 {
            return Err(state_error());
        }
        validate_page(&next_pages[indices[0]], page_ref).map_err(|_| state_error())?;
    }

    for change in changes {
        let key = (change.page_id.clone(), change.object_id.clone());
        if seen_change_ids.contains(&key)
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
        seen_change_ids.push(key);

        let index = page_index(&next_pages, &change.page_id).map_err(|_| {
            operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo target page no longer exists",
            )
        })?;
        let object_index = next_pages[index]
            .objects
            .iter()
            .position(|object| object.id == change.object_id);
        let current = object_index.map(|position| next_pages[index].objects[position].clone());
        if current != change.after {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo target object changed after the AI operation",
            ));
        }

        match (&change.before, object_index) {
            (Some(before), Some(position)) => next_pages[index].objects[position] = before.clone(),
            (Some(before), None) => next_pages[index].objects.push(before.clone()),
            (None, Some(position)) => {
                next_pages[index].objects.remove(position);
            }
            (None, None) => unreachable!("empty before/after changes were rejected"),
        }
        push_affected(&mut affected_page_ids, &change.page_id);
    }

    let mut seen_appended_ids = Vec::new();
    for page_id in appended_page_ids {
        if seen_appended_ids.iter().any(|seen| *seen == page_id) {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo append-page list contains a duplicate page",
            ));
        }
        seen_appended_ids.push(page_id);
        if next_manifest.pages.len() <= 1 {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo cannot remove the last document page",
            ));
        }
        let index = page_index(&next_pages, page_id).map_err(|_| {
            operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo appended page no longer exists",
            )
        })?;
        if !next_pages[index].objects.is_empty() {
            return Err(operation_error(
                InkOperationErrorCode::RevisionConflict,
                "Undo cannot remove an appended page with remaining objects",
            ));
        }
        next_pages.remove(index);
        let ref_index = next_manifest
            .pages
            .iter()
            .position(|page_ref| page_ref.page_id == *page_id)
            .ok_or_else(|| {
                operation_error(
                    InkOperationErrorCode::RevisionConflict,
                    "Undo appended page reference no longer exists",
                )
            })?;
        next_manifest.pages.remove(ref_index);
        push_affected(&mut affected_page_ids, page_id);
    }

    for page_id in &affected_page_ids {
        if let Ok(index) = page_index(&next_pages, page_id) {
            let page_ref = next_manifest
                .pages
                .iter_mut()
                .find(|page_ref| page_ref.page_id == *page_id)
                .ok_or_else(state_error)?;
            validate_page(&next_pages[index], page_ref).map_err(|_| {
                operation_error(
                    InkOperationErrorCode::ContentInvalid,
                    "Undo result violates page constraints",
                )
            })?;
            page_ref.page_blob_hash = page_hash(&next_pages[index])?;
        }
    }
    validate_manifest(&next_manifest).map_err(|_| state_error())?;

    Ok(InkOperationsResult {
        manifest: next_manifest,
        pages: next_pages,
        affected_page_ids,
        object_changes: Vec::new(),
        appended_page_ids: Vec::new(),
    })
}

fn operation_error(code: InkOperationErrorCode, message: &'static str) -> InkOperationError {
    InkOperationError {
        code,
        message: message.to_owned(),
    }
}

fn state_error() -> InkOperationError {
    operation_error(
        InkOperationErrorCode::ContentInvalid,
        "Ink operation input state is invalid",
    )
}

fn page_index(pages: &[InkPage], page_id: &str) -> Result<usize, InkOperationError> {
    pages
        .iter()
        .position(|page| page.page_id == page_id)
        .ok_or_else(|| operation_error(InkOperationErrorCode::PageNotFound, "Ink page not found"))
}

fn check_mapping<'a>(
    manifest: &InkManifest,
    page_ref: &InkPageRef,
    render_id: &str,
    mappings: &'a [InkRenderMapping],
) -> Result<&'a InkRenderMapping, InkOperationError> {
    let mut matches = mappings
        .iter()
        .filter(|mapping| mapping.render_id == render_id);
    let mapping = matches.next().ok_or_else(|| {
        operation_error(
            InkOperationErrorCode::RenderMappingRequired,
            "A verified render mapping is required",
        )
    })?;
    if matches.next().is_some()
        || mapping.document_id != manifest.document_id
        || mapping.page_id != page_ref.page_id
        || !valid_logical_rect(mapping.crop, page_ref.width, page_ref.height)
    {
        return Err(operation_error(
            InkOperationErrorCode::RenderMappingMismatch,
            "Render mapping does not match the document page",
        ));
    }
    if mapping.revision != manifest.revision {
        return Err(operation_error(
            InkOperationErrorCode::RevisionConflict,
            "Render mapping is based on a different document revision",
        ));
    }
    Ok(mapping)
}

fn valid_logical_rect(rect: InkRect, page_width: f64, page_height: f64) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.x >= 0.0
        && rect.y >= 0.0
        && rect.width > 0.0
        && rect.height > 0.0
        && (rect.x + rect.width).is_finite()
        && (rect.y + rect.height).is_finite()
        && rect.x + rect.width <= page_width
        && rect.y + rect.height <= page_height
}

fn normalized_rect_valid(rect: InkNormalizedRect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.x >= 0.0
        && rect.y >= 0.0
        && rect.width > 0.0
        && rect.height > 0.0
        && rect.x + rect.width <= 1.0
        && rect.y + rect.height <= 1.0
}

fn normalized_point_valid(point: InkNormalizedPoint) -> bool {
    point.x.is_finite()
        && point.y.is_finite()
        && (0.0..=1.0).contains(&point.x)
        && (0.0..=1.0).contains(&point.y)
}

fn map_point(
    point: InkNormalizedPoint,
    space: InkCoordinateSpace,
    page_ref: &InkPageRef,
    mapping: &InkRenderMapping,
) -> Result<InkPoint, InkOperationError> {
    let (origin_x, origin_y, extent_width, extent_height) = match space {
        InkCoordinateSpace::Page => (0.0, 0.0, page_ref.width, page_ref.height),
        InkCoordinateSpace::RenderCrop => (
            mapping.crop.x,
            mapping.crop.y,
            mapping.crop.width,
            mapping.crop.height,
        ),
    };
    map_point_from_extent(point, origin_x, origin_y, extent_width, extent_height)
}

/// Map a normalized point into an explicit origin/extent. The v1 page path
/// derives the extent from the page; the board path derives it from the
/// verified signed world crop. Normalization rules stay shared and strict.
pub(crate) fn map_point_from_extent(
    point: InkNormalizedPoint,
    origin_x: f64,
    origin_y: f64,
    extent_width: f64,
    extent_height: f64,
) -> Result<InkPoint, InkOperationError> {
    if !normalized_point_valid(point) {
        return Err(operation_error(
            InkOperationErrorCode::GeometryInvalid,
            "Normalized point is outside the coordinate space",
        ));
    }
    Ok(InkPoint {
        x: origin_x + point.x * extent_width,
        y: origin_y + point.y * extent_height,
    })
}

fn map_rect(
    rect: InkNormalizedRect,
    space: InkCoordinateSpace,
    page_ref: &InkPageRef,
    mapping: &InkRenderMapping,
) -> Result<InkRect, InkOperationError> {
    let (origin_x, origin_y, extent_width, extent_height) = match space {
        InkCoordinateSpace::Page => (0.0, 0.0, page_ref.width, page_ref.height),
        InkCoordinateSpace::RenderCrop => (
            mapping.crop.x,
            mapping.crop.y,
            mapping.crop.width,
            mapping.crop.height,
        ),
    };
    map_rect_from_extent(rect, origin_x, origin_y, extent_width, extent_height)
}

/// Map a normalized rectangle into an explicit origin/extent. Negative origins
/// are only supplied by the board path; paged callers still use nonnegative
/// page coordinates and their existing bounds checks.
pub(crate) fn map_rect_from_extent(
    rect: InkNormalizedRect,
    origin_x: f64,
    origin_y: f64,
    extent_width: f64,
    extent_height: f64,
) -> Result<InkRect, InkOperationError> {
    if !normalized_rect_valid(rect) {
        return Err(operation_error(
            InkOperationErrorCode::GeometryInvalid,
            "Normalized rectangle is outside the coordinate space",
        ));
    }
    Ok(InkRect {
        x: origin_x + rect.x * extent_width,
        y: origin_y + rect.y * extent_height,
        width: rect.width * extent_width,
        height: rect.height * extent_height,
    })
}

fn map_content(
    content: InkOperationContent,
    space: InkCoordinateSpace,
    page_ref: &InkPageRef,
    mapping: &InkRenderMapping,
) -> Result<InkObjectContent, InkOperationError> {
    let (origin_x, origin_y, extent_width, extent_height) = match space {
        InkCoordinateSpace::Page => (0.0, 0.0, page_ref.width, page_ref.height),
        InkCoordinateSpace::RenderCrop => (
            mapping.crop.x,
            mapping.crop.y,
            mapping.crop.width,
            mapping.crop.height,
        ),
    };
    map_content_from_extent(content, origin_x, origin_y, extent_width, extent_height)
}

/// Shared controlled-content mapping for explicit origin/extent. Stroke content
/// is intentionally absent from `InkOperationContent`, so this never creates a
/// new stroke from AI input.
pub(crate) fn map_content_from_extent(
    content: InkOperationContent,
    origin_x: f64,
    origin_y: f64,
    extent_width: f64,
    extent_height: f64,
) -> Result<InkObjectContent, InkOperationError> {
    Ok(match content {
        InkOperationContent::Text {
            rect,
            text,
            font_size,
            color,
        } => InkObjectContent::Text {
            rect: map_rect_from_extent(rect, origin_x, origin_y, extent_width, extent_height)?,
            text,
            font_size,
            color,
        },
        InkOperationContent::Rect { rect, color, width } => InkObjectContent::Rect {
            rect: map_rect_from_extent(rect, origin_x, origin_y, extent_width, extent_height)?,
            color,
            width,
        },
        InkOperationContent::Ellipse { rect, color, width } => InkObjectContent::Ellipse {
            rect: map_rect_from_extent(rect, origin_x, origin_y, extent_width, extent_height)?,
            color,
            width,
        },
        InkOperationContent::RegionHighlight { rect, color, width } => {
            InkObjectContent::RegionHighlight {
                rect: map_rect_from_extent(rect, origin_x, origin_y, extent_width, extent_height)?,
                color,
                width,
            }
        }
        InkOperationContent::Arrow {
            from,
            to,
            color,
            width,
        } => InkObjectContent::Arrow {
            from: map_point_from_extent(from, origin_x, origin_y, extent_width, extent_height)?,
            to: map_point_from_extent(to, origin_x, origin_y, extent_width, extent_height)?,
            color,
            width,
        },
    })
}

fn push_affected(affected: &mut Vec<String>, page_id: &str) {
    if !affected.iter().any(|existing| existing == page_id) {
        affected.push(page_id.to_owned());
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

fn page_hash(page: &InkPage) -> Result<String, InkOperationError> {
    let bytes = serde_json::to_vec(page).map_err(|_| state_error())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

/// Apply 1–100 operations atomically to cloned domain state.
pub fn apply_operations(
    manifest: &InkManifest,
    pages: &[InkPage],
    operations: &[InkOperation],
    render_mappings: &[InkRenderMapping],
) -> Result<InkOperationsResult, InkOperationError> {
    if operations.is_empty() || operations.len() > 100 {
        return Err(operation_error(
            InkOperationErrorCode::BatchSizeInvalid,
            "Ink operation batch must contain 1 to 100 operations",
        ));
    }
    validate_manifest(manifest).map_err(|_| state_error())?;
    if pages.len() != manifest.pages.len() {
        return Err(state_error());
    }

    let mut next_manifest = manifest.clone();
    let mut next_pages = pages.to_vec();
    for page_ref in &manifest.pages {
        let index = page_index(&next_pages, &page_ref.page_id)?;
        validate_page(&next_pages[index], page_ref).map_err(|_| state_error())?;
    }
    let mut affected_page_ids = Vec::new();
    let mut object_changes = Vec::new();
    let mut appended_page_ids = Vec::new();

    for operation in operations {
        match operation {
            InkOperation::AppendBlankPage {
                page_id,
                width,
                height,
                ruling,
            } => {
                if next_manifest
                    .pages
                    .iter()
                    .any(|page_ref| page_ref.page_id == *page_id)
                {
                    return Err(operation_error(
                        InkOperationErrorCode::DuplicateId,
                        "Ink page ID already exists",
                    ));
                }
                if next_pages.len() >= INK_PAGES_MAX {
                    return Err(operation_error(
                        InkOperationErrorCode::PageLimitExceeded,
                        "Ink document page limit exceeded",
                    ));
                }
                let mut page = InkPage {
                    schema_version: INK_SCHEMA_VERSION,
                    page_id: page_id.clone(),
                    objects: Vec::new(),
                };
                let page_ref = InkPageRef {
                    page_id: page_id.clone(),
                    width: *width,
                    height: *height,
                    background: InkBackground::Blank { ruling: *ruling },
                    page_blob_hash: page_hash(&page)?,
                };
                validate_page(&page, &page_ref).map_err(|_| state_error())?;
                next_manifest.pages.push(page_ref);
                next_pages.push(page.clone());
                affected_page_ids.push(page_id.clone());
                appended_page_ids.push(page_id.clone());
                page.objects.clear();
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
                let index = page_index(&next_pages, page_id)?;
                let page_ref = next_manifest
                    .pages
                    .iter()
                    .find(|page_ref| page_ref.page_id == *page_id)
                    .ok_or_else(|| {
                        operation_error(InkOperationErrorCode::PageNotFound, "Ink page not found")
                    })?;
                let mapping = check_mapping(
                    &next_manifest,
                    page_ref,
                    based_on_render_id,
                    render_mappings,
                )?;
                add_object(
                    page_id,
                    &mut next_pages[index],
                    InkObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        content: InkObjectContent::Text {
                            rect: map_rect(*rect, *coordinate_space, page_ref, mapping)?,
                            text: text.clone(),
                            font_size: *font_size,
                            color: color.clone(),
                        },
                    },
                    &mut object_changes,
                )?;
                push_affected(&mut affected_page_ids, page_id);
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
                let index = page_index(&next_pages, page_id)?;
                let page_ref = next_manifest
                    .pages
                    .iter()
                    .find(|page_ref| page_ref.page_id == *page_id)
                    .ok_or_else(|| {
                        operation_error(InkOperationErrorCode::PageNotFound, "Ink page not found")
                    })?;
                let mapping = check_mapping(
                    &next_manifest,
                    page_ref,
                    based_on_render_id,
                    render_mappings,
                )?;
                let logical_rect = map_rect(*rect, *coordinate_space, page_ref, mapping)?;
                let content = match operation {
                    InkOperation::AddRect { .. } => InkObjectContent::Rect {
                        rect: logical_rect,
                        color: color.clone(),
                        width: *width,
                    },
                    InkOperation::AddEllipse { .. } => InkObjectContent::Ellipse {
                        rect: logical_rect,
                        color: color.clone(),
                        width: *width,
                    },
                    _ => InkObjectContent::RegionHighlight {
                        rect: logical_rect,
                        color: color.clone(),
                        width: *width,
                    },
                };
                add_object(
                    page_id,
                    &mut next_pages[index],
                    InkObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        content,
                    },
                    &mut object_changes,
                )?;
                push_affected(&mut affected_page_ids, page_id);
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
                let index = page_index(&next_pages, page_id)?;
                let page_ref = next_manifest
                    .pages
                    .iter()
                    .find(|page_ref| page_ref.page_id == *page_id)
                    .ok_or_else(|| {
                        operation_error(InkOperationErrorCode::PageNotFound, "Ink page not found")
                    })?;
                let mapping = check_mapping(
                    &next_manifest,
                    page_ref,
                    based_on_render_id,
                    render_mappings,
                )?;
                add_object(
                    page_id,
                    &mut next_pages[index],
                    InkObject {
                        id: object_id.clone(),
                        author: InkAuthor::Ai,
                        created_at: *created_at,
                        content: InkObjectContent::Arrow {
                            from: map_point(*from, *coordinate_space, page_ref, mapping)?,
                            to: map_point(*to, *coordinate_space, page_ref, mapping)?,
                            color: color.clone(),
                            width: *width,
                        },
                    },
                    &mut object_changes,
                )?;
                push_affected(&mut affected_page_ids, page_id);
            }
            InkOperation::UpdateObject {
                page_id,
                object_id,
                coordinate_space,
                based_on_render_id,
                content,
            } => {
                let index = page_index(&next_pages, page_id)?;
                let page_ref = next_manifest
                    .pages
                    .iter()
                    .find(|page_ref| page_ref.page_id == *page_id)
                    .ok_or_else(|| {
                        operation_error(InkOperationErrorCode::PageNotFound, "Ink page not found")
                    })?;
                let mapping = check_mapping(
                    &next_manifest,
                    page_ref,
                    based_on_render_id,
                    render_mappings,
                )?;
                let content = map_content(content.clone(), *coordinate_space, page_ref, mapping)?;
                let object = next_pages[index]
                    .objects
                    .iter_mut()
                    .find(|object| object.id == *object_id)
                    .ok_or_else(|| {
                        operation_error(
                            InkOperationErrorCode::ObjectNotFound,
                            "Ink object not found",
                        )
                    })?;
                let before = object.clone();
                if matches!(&before.content, InkObjectContent::Stroke { .. }) {
                    return Err(operation_error(
                        InkOperationErrorCode::UnsupportedStrokeUpdate,
                        "Ink stroke objects cannot be replaced by tool operations",
                    ));
                }
                object.content = content;
                record_change(
                    &mut object_changes,
                    InkObjectChange {
                        page_id: page_id.clone(),
                        object_id: object_id.clone(),
                        before: Some(before),
                        after: Some(object.clone()),
                        z_index: None,
                    },
                );
                push_affected(&mut affected_page_ids, page_id);
            }
            InkOperation::RemoveObject { page_id, object_id } => {
                let index = page_index(&next_pages, page_id)?;
                let object_index = next_pages[index]
                    .objects
                    .iter()
                    .position(|object| object.id == *object_id)
                    .ok_or_else(|| {
                        operation_error(
                            InkOperationErrorCode::ObjectNotFound,
                            "Ink object not found",
                        )
                    })?;
                let before = next_pages[index].objects.remove(object_index);
                record_change(
                    &mut object_changes,
                    InkObjectChange {
                        page_id: page_id.clone(),
                        object_id: object_id.clone(),
                        before: Some(before),
                        after: None,
                        z_index: None,
                    },
                );
                push_affected(&mut affected_page_ids, page_id);
            }
        }
    }

    object_changes.retain(|change| change.before != change.after);
    for page_id in &affected_page_ids {
        let index = page_index(&next_pages, page_id)?;
        let page_ref = next_manifest
            .pages
            .iter_mut()
            .find(|page_ref| page_ref.page_id == *page_id)
            .ok_or_else(state_error)?;
        validate_page(&next_pages[index], page_ref).map_err(|_| {
            operation_error(
                InkOperationErrorCode::ContentInvalid,
                "Ink operation result violates page constraints",
            )
        })?;
        page_ref.page_blob_hash = page_hash(&next_pages[index])?;
    }
    validate_manifest(&next_manifest).map_err(|_| state_error())?;

    Ok(InkOperationsResult {
        manifest: next_manifest,
        pages: next_pages,
        affected_page_ids,
        object_changes,
        appended_page_ids,
    })
}

fn add_object(
    page_id: &str,
    page: &mut InkPage,
    object: InkObject,
    changes: &mut Vec<InkObjectChange>,
) -> Result<(), InkOperationError> {
    if page.objects.iter().any(|existing| existing.id == object.id) {
        return Err(operation_error(
            InkOperationErrorCode::DuplicateId,
            "Ink object ID already exists on the page",
        ));
    }
    if page.objects.len() >= INK_PAGE_OBJECTS_MAX {
        return Err(operation_error(
            InkOperationErrorCode::ContentInvalid,
            "Ink page object limit exceeded",
        ));
    }
    record_change(
        changes,
        InkObjectChange {
            page_id: page_id.to_owned(),
            object_id: object.id.clone(),
            before: None,
            after: Some(object.clone()),
            z_index: None,
        },
    );
    page.objects.push(object);
    Ok(())
}
