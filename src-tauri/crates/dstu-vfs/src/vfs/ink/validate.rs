//! `.dsink` domain validation.

use std::collections::HashSet;

use super::{
    InkBackground, InkError, InkErrorCode, InkManifest, InkObjectContent, InkPage, InkPageRef,
    InkPoint, InkRect, InkSource, INK_BOARD_SCHEMA_VERSION, INK_DIMENSION_MAX, INK_DIMENSION_MIN,
    INK_FONT_SIZE_MAX, INK_FONT_SIZE_MIN, INK_ID_MAX_CHARS, INK_PAGES_MAX, INK_PAGES_MIN,
    INK_PAGE_OBJECTS_MAX, INK_PAGE_SAMPLES_MAX, INK_SCHEMA_VERSION, INK_STROKE_MIN_SAMPLES,
    INK_TEXT_MAX_CHARS, INK_TITLE_MAX_CHARS, INK_WIDTH_MAX,
};

fn invalid_argument(message: &'static str) -> InkError {
    InkError {
        code: InkErrorCode::InvalidArgument,
        message: message.to_owned(),
    }
}

fn limit_exceeded(message: &'static str) -> InkError {
    InkError {
        code: InkErrorCode::LimitExceeded,
        message: message.to_owned(),
    }
}

fn unsupported_schema() -> InkError {
    InkError {
        code: InkErrorCode::UnsupportedSchema,
        message: "Unsupported Ink schema version".to_owned(),
    }
}

pub(super) fn validate_id(value: &str) -> Result<(), InkError> {
    let length = value.chars().count();
    if length == 0 || value.trim().is_empty() {
        return Err(invalid_argument("Ink identifier must be nonempty"));
    }
    if length > INK_ID_MAX_CHARS {
        return Err(limit_exceeded("Ink identifier exceeds the character limit"));
    }
    if value
        .chars()
        .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(invalid_argument(
            "Ink identifier contains a forbidden character",
        ));
    }
    Ok(())
}

pub(super) fn validate_revision(value: &str) -> Result<(), InkError> {
    if value.trim().is_empty() {
        return Err(invalid_argument("Ink revision must be nonempty"));
    }
    if value.chars().count() > INK_ID_MAX_CHARS {
        return Err(limit_exceeded("Ink revision exceeds the character limit"));
    }
    Ok(())
}

pub(super) fn validate_hash(value: &str) -> Result<(), InkError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_argument("Ink hash must be lowercase SHA-256 hex"));
    }
    Ok(())
}

pub(super) fn validate_color(value: &str) -> Result<(), InkError> {
    if !matches!(value.len(), 7 | 9)
        || !value.starts_with('#')
        || !value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(invalid_argument("Ink color must be #RRGGBB or #RRGGBBAA"));
    }
    Ok(())
}

fn validate_dimension(value: f64) -> Result<(), InkError> {
    if !value.is_finite() || !(INK_DIMENSION_MIN..=INK_DIMENSION_MAX).contains(&value) {
        return Err(invalid_argument(
            "Ink page dimension is outside the allowed range",
        ));
    }
    Ok(())
}

fn validate_background(background: &InkBackground) -> Result<(), InkError> {
    match background {
        InkBackground::Blank { .. } => Ok(()),
        InkBackground::Image { blob_hash } | InkBackground::PdfPage { blob_hash, .. } => {
            validate_hash(blob_hash)
        }
    }
}

fn validate_page_ref(page_ref: &InkPageRef) -> Result<(), InkError> {
    validate_id(&page_ref.page_id)?;
    validate_dimension(page_ref.width)?;
    validate_dimension(page_ref.height)?;
    validate_background(&page_ref.background)?;
    validate_hash(&page_ref.page_blob_hash)
}

pub(super) fn validate_width(width: f64) -> Result<(), InkError> {
    if !width.is_finite() || width <= 0.0 || width > INK_WIDTH_MAX {
        return Err(invalid_argument(
            "Ink stroke width is outside the allowed range",
        ));
    }
    Ok(())
}

fn validate_point(point: InkPoint, page_ref: &InkPageRef) -> Result<(), InkError> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x > page_ref.width
        || point.y > page_ref.height
    {
        return Err(invalid_argument("Ink point is outside the page bounds"));
    }
    Ok(())
}

fn validate_rect(rect: InkRect, page_ref: &InkPageRef) -> Result<(), InkError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.x + rect.width > page_ref.width
        || rect.y + rect.height > page_ref.height
    {
        return Err(invalid_argument("Ink rectangle is outside the page bounds"));
    }
    Ok(())
}

fn validate_shape(
    rect: InkRect,
    color: &str,
    width: f64,
    page_ref: &InkPageRef,
) -> Result<(), InkError> {
    validate_rect(rect, page_ref)?;
    validate_color(color)?;
    validate_width(width)
}

/// Validate all fields and cross-field constraints in a loaded manifest.
pub fn validate_manifest(manifest: &InkManifest) -> Result<(), InkError> {
    if manifest.schema_version == INK_BOARD_SCHEMA_VERSION {
        return super::board::validate_board_manifest(manifest);
    }
    if manifest.schema_version != INK_SCHEMA_VERSION {
        return Err(unsupported_schema());
    }
    // v1 严格契约：直接构造的域值也不得携带 board 字段。
    if manifest.surface.is_some() || !manifest.chunks.is_empty() {
        return Err(invalid_argument(
            "Ink v1 manifest must not contain board fields",
        ));
    }
    if manifest.pages.len() < INK_PAGES_MIN {
        return Err(invalid_argument(
            "Ink manifest must contain at least one page",
        ));
    }
    if manifest.pages.len() > INK_PAGES_MAX {
        return Err(limit_exceeded("Ink manifest exceeds the page limit"));
    }

    validate_id(&manifest.document_id)?;
    validate_revision(&manifest.revision)?;
    if manifest.title.is_empty() {
        return Err(invalid_argument("Ink title must be nonempty"));
    }
    if manifest.title.chars().count() > INK_TITLE_MAX_CHARS {
        return Err(limit_exceeded("Ink title exceeds the character limit"));
    }

    match &manifest.source {
        InkSource::Blank {} => {}
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            validate_id(resource_id)?;
            validate_hash(source_hash)?;
            if conversion_revision.is_empty() {
                return Err(invalid_argument("Ink conversion revision must be nonempty"));
            }
        }
    }

    let mut page_ids = HashSet::with_capacity(manifest.pages.len());
    for page_ref in &manifest.pages {
        validate_page_ref(page_ref)?;
        if !page_ids.insert(page_ref.page_id.as_str()) {
            return Err(invalid_argument("Ink manifest contains duplicate page IDs"));
        }
    }

    if let Some(receipt) = &manifest.last_operation {
        validate_id(&receipt.operation_id)?;
        validate_hash(&receipt.input_hash)?;
        if receipt.result_revision != manifest.revision {
            return Err(invalid_argument(
                "Ink receipt revision does not match manifest revision",
            ));
        }
        if let Some(previous_revision) = &receipt.previous_revision {
            validate_revision(previous_revision)?;
        }
    }
    Ok(())
}

/// Validate all page objects against their logical page bounds and budgets.
pub fn validate_page(page: &InkPage, page_ref: &InkPageRef) -> Result<(), InkError> {
    if page.schema_version != INK_SCHEMA_VERSION {
        return Err(unsupported_schema());
    }
    validate_page_ref(page_ref)?;
    if page.page_id != page_ref.page_id {
        return Err(invalid_argument(
            "Ink page ID does not match its manifest reference",
        ));
    }
    if page.objects.len() > INK_PAGE_OBJECTS_MAX {
        return Err(limit_exceeded("Ink page exceeds the object limit"));
    }

    let mut object_ids = HashSet::with_capacity(page.objects.len());
    let mut total_samples = 0usize;
    for object in &page.objects {
        validate_id(&object.id)?;
        if !object_ids.insert(object.id.as_str()) {
            return Err(invalid_argument("Ink page contains duplicate object IDs"));
        }
        if object.created_at < 0 {
            return Err(invalid_argument(
                "Ink object creation time must be nonnegative",
            ));
        }

        match &object.content {
            InkObjectContent::Stroke { samples, style } => {
                if samples.len() < INK_STROKE_MIN_SAMPLES {
                    return Err(invalid_argument(
                        "Ink stroke must contain at least one sample",
                    ));
                }
                total_samples = total_samples
                    .checked_add(samples.len())
                    .ok_or_else(|| limit_exceeded("Ink page exceeds the sample limit"))?;
                if total_samples > INK_PAGE_SAMPLES_MAX {
                    return Err(limit_exceeded("Ink page exceeds the sample limit"));
                }
                validate_color(&style.color)?;
                validate_width(style.width)?;

                let mut previous_elapsed = None;
                for sample in samples {
                    validate_point(
                        InkPoint {
                            x: sample.x,
                            y: sample.y,
                        },
                        page_ref,
                    )?;
                    if !sample.pressure.is_finite() || !(0.0..=1.0).contains(&sample.pressure) {
                        return Err(invalid_argument(
                            "Ink sample pressure must be between 0 and 1",
                        ));
                    }
                    if let Some(elapsed_ms) = sample.elapsed_ms {
                        if !elapsed_ms.is_finite() || elapsed_ms < 0.0 {
                            return Err(invalid_argument(
                                "Ink sample elapsed time must be finite and nonnegative",
                            ));
                        }
                        if previous_elapsed.is_some_and(|previous| elapsed_ms < previous) {
                            return Err(invalid_argument(
                                "Ink stroke elapsed times must be nondecreasing",
                            ));
                        }
                        previous_elapsed = Some(elapsed_ms);
                    }
                }
            }
            InkObjectContent::Text {
                rect,
                text,
                font_size,
                color,
            } => {
                validate_rect(*rect, page_ref)?;
                validate_color(color)?;
                if !font_size.is_finite()
                    || !(INK_FONT_SIZE_MIN..=INK_FONT_SIZE_MAX).contains(font_size)
                {
                    return Err(invalid_argument(
                        "Ink text font size is outside the allowed range",
                    ));
                }
                if text.chars().count() > INK_TEXT_MAX_CHARS {
                    return Err(limit_exceeded("Ink text exceeds the character limit"));
                }
            }
            InkObjectContent::Rect { rect, color, width }
            | InkObjectContent::Ellipse { rect, color, width }
            | InkObjectContent::RegionHighlight { rect, color, width } => {
                validate_shape(*rect, color, *width, page_ref)?;
            }
            InkObjectContent::Arrow {
                from,
                to,
                color,
                width,
            } => {
                validate_point(*from, page_ref)?;
                validate_point(*to, page_ref)?;
                validate_color(color)?;
                validate_width(*width)?;
            }
        }
    }
    Ok(())
}
