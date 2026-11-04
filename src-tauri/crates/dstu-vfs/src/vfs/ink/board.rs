//! v2 无限画布 board 域的预算、几何与元数据验证。
//!
//! board 对象复用 `InkObjectContent`，但坐标为带符号世界坐标；v1 的页内
//! 边界校验完全不变。这里的所有数值检查都先要求有限，再检查 ±10,000,000
//! logical units 的安全范围。

use std::collections::HashSet;

use super::types::{
    InkBoardBounds, InkBoardChunk, InkBoardChunkRef, InkBoardSurface, InkError, InkErrorCode,
    InkManifest, InkObjectContent, InkPoint, InkRect, InkSource, INK_BOARD_SCHEMA_VERSION,
};
use super::validate::{
    validate_color, validate_hash, validate_id, validate_revision, validate_width,
};
use super::{
    INK_FONT_SIZE_MAX, INK_FONT_SIZE_MIN, INK_STROKE_MIN_SAMPLES, INK_TEXT_MAX_CHARS,
    INK_TITLE_MAX_CHARS,
};

/// board 世界坐标的数值安全范围：±10,000,000 logical units。
pub const INK_BOARD_WORLD_LIMIT: f64 = 10_000_000.0;
/// board manifest 最多引用 256 个 chunk。
pub const INK_BOARD_CHUNKS_MAX: usize = 256;
/// board 文档对象总数上限。
pub const INK_BOARD_OBJECTS_MAX: u32 = 100_000;
/// board 文档采样点总数上限。
pub const INK_BOARD_SAMPLES_MAX: u32 = 2_000_000;
/// board 文档 chunk 序列化内容总预算（64 MiB）。
pub const INK_BOARD_CONTENT_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 单个 chunk blob 的字节上限（8 MiB，与 v1 单页一致）。
pub const INK_BOARD_CHUNK_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 单个 chunk 的对象上限。
pub const INK_BOARD_CHUNK_OBJECTS_MAX: u32 = 10_000;
/// 单个 chunk 的采样点上限。
pub const INK_BOARD_CHUNK_SAMPLES_MAX: u32 = 100_000;

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

fn in_world_range(value: f64) -> bool {
    value.is_finite() && value.abs() <= INK_BOARD_WORLD_LIMIT
}

/// board 包围范围必须有限、正宽高，且整块范围落在世界坐标安全范围内。
pub fn validate_board_bounds(bounds: &InkBoardBounds) -> Result<(), InkError> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.x < -INK_BOARD_WORLD_LIMIT
        || bounds.y < -INK_BOARD_WORLD_LIMIT
        || bounds.x + bounds.width > INK_BOARD_WORLD_LIMIT
        || bounds.y + bounds.height > INK_BOARD_WORLD_LIMIT
    {
        return Err(invalid_argument(
            "Ink board bounds are outside the allowed range",
        ));
    }
    Ok(())
}

fn validate_board_surface(surface: &InkBoardSurface) -> Result<(), InkError> {
    match surface {
        InkBoardSurface::Board {
            page_id, bounds, ..
        } => {
            validate_id(page_id)?;
            validate_board_bounds(bounds)
        }
    }
}

fn validate_board_chunk_ref(chunk_ref: &InkBoardChunkRef) -> Result<(), InkError> {
    validate_id(&chunk_ref.chunk_id)?;
    validate_hash(&chunk_ref.blob_hash)?;
    if chunk_ref.byte_length == 0 {
        return Err(invalid_argument(
            "Ink board chunk byte length must be nonempty",
        ));
    }
    if chunk_ref.byte_length > INK_BOARD_CHUNK_MAX_BYTES as u64 {
        return Err(limit_exceeded("Ink board chunk exceeds the byte limit"));
    }
    if chunk_ref.object_count == 0 {
        return Err(invalid_argument(
            "Ink board chunk must contain at least one object",
        ));
    }
    if chunk_ref.object_count > INK_BOARD_CHUNK_OBJECTS_MAX {
        return Err(limit_exceeded("Ink board chunk exceeds the object limit"));
    }
    if chunk_ref.sample_count > INK_BOARD_CHUNK_SAMPLES_MAX {
        return Err(limit_exceeded("Ink board chunk exceeds the sample limit"));
    }
    validate_board_bounds(&chunk_ref.bounds)
}

fn validate_board_point(point: &InkPoint) -> Result<(), InkError> {
    if !in_world_range(point.x) || !in_world_range(point.y) {
        return Err(invalid_argument(
            "Ink board point is outside the world range",
        ));
    }
    Ok(())
}

fn validate_board_rect(rect: &InkRect) -> Result<(), InkError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.x < -INK_BOARD_WORLD_LIMIT
        || rect.y < -INK_BOARD_WORLD_LIMIT
        || rect.x + rect.width > INK_BOARD_WORLD_LIMIT
        || rect.y + rect.height > INK_BOARD_WORLD_LIMIT
    {
        return Err(invalid_argument(
            "Ink board rectangle is outside the world range",
        ));
    }
    Ok(())
}

fn validate_board_shape(rect: &InkRect, color: &str, width: f64) -> Result<(), InkError> {
    validate_board_rect(rect)?;
    validate_color(color)?;
    validate_width(width)
}

/// 校验一个 board 对象内容，返回其中的采样点数量。
fn validate_board_object_content(content: &InkObjectContent) -> Result<u32, InkError> {
    match content {
        InkObjectContent::Stroke { samples, style } => {
            if samples.len() < INK_STROKE_MIN_SAMPLES {
                return Err(invalid_argument(
                    "Ink stroke must contain at least one sample",
                ));
            }
            let sample_count = u32::try_from(samples.len())
                .map_err(|_| limit_exceeded("Ink board chunk exceeds the sample limit"))?;
            if sample_count > INK_BOARD_CHUNK_SAMPLES_MAX {
                return Err(limit_exceeded("Ink board chunk exceeds the sample limit"));
            }
            validate_color(&style.color)?;
            validate_width(style.width)?;

            let mut previous_elapsed = None;
            for sample in samples {
                validate_board_point(&InkPoint {
                    x: sample.x,
                    y: sample.y,
                })?;
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
            Ok(sample_count)
        }
        InkObjectContent::Text {
            rect,
            text,
            font_size,
            color,
        } => {
            validate_board_rect(rect)?;
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
            Ok(0)
        }
        InkObjectContent::Rect { rect, color, width }
        | InkObjectContent::Ellipse { rect, color, width }
        | InkObjectContent::RegionHighlight { rect, color, width } => {
            validate_board_shape(rect, color, *width)?;
            Ok(0)
        }
        InkObjectContent::Arrow {
            from,
            to,
            color,
            width,
        } => {
            validate_board_point(from)?;
            validate_board_point(to)?;
            validate_color(color)?;
            validate_width(*width)?;
            Ok(0)
        }
    }
}

/// 校验 chunk 正文与 manifest 元数据的一致性。
pub fn validate_board_chunk(
    chunk: &InkBoardChunk,
    chunk_ref: &InkBoardChunkRef,
) -> Result<(), InkError> {
    if chunk.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(unsupported_schema());
    }
    validate_id(&chunk.chunk_id)?;
    validate_board_chunk_ref(chunk_ref)?;
    if chunk.chunk_id != chunk_ref.chunk_id {
        return Err(invalid_argument(
            "Ink board chunk ID does not match its manifest reference",
        ));
    }
    if chunk.objects.len() > INK_BOARD_CHUNK_OBJECTS_MAX as usize {
        return Err(limit_exceeded("Ink board chunk exceeds the object limit"));
    }
    if chunk_ref.object_count as usize != chunk.objects.len() {
        return Err(invalid_argument(
            "Ink board chunk object count does not match its manifest reference",
        ));
    }

    let mut object_ids = HashSet::with_capacity(chunk.objects.len());
    let mut total_samples: u32 = 0;
    for object in &chunk.objects {
        validate_id(&object.id)?;
        if !object_ids.insert(object.id.as_str()) {
            return Err(invalid_argument(
                "Ink board chunk contains duplicate object IDs",
            ));
        }
        if object.created_at < 0 {
            return Err(invalid_argument(
                "Ink object creation time must be nonnegative",
            ));
        }
        if object.z_index < 0 {
            return Err(invalid_argument("Ink board z-index must be nonnegative"));
        }
        let samples = validate_board_object_content(&object.content)?;
        total_samples = total_samples
            .checked_add(samples)
            .ok_or_else(|| limit_exceeded("Ink board chunk exceeds the sample limit"))?;
        if total_samples > INK_BOARD_CHUNK_SAMPLES_MAX {
            return Err(limit_exceeded("Ink board chunk exceeds the sample limit"));
        }
    }
    if chunk_ref.sample_count != total_samples {
        return Err(invalid_argument(
            "Ink board chunk sample count does not match its manifest reference",
        ));
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<(), InkError> {
    if title.is_empty() {
        return Err(invalid_argument("Ink title must be nonempty"));
    }
    if title.chars().count() > INK_TITLE_MAX_CHARS {
        return Err(limit_exceeded("Ink title exceeds the character limit"));
    }
    Ok(())
}

fn validate_receipt(manifest: &InkManifest) -> Result<(), InkError> {
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

/// v2 board manifest 的完整验证：仅 blank 来源、无固定页、严格 chunk 预算。
pub(super) fn validate_board_manifest(manifest: &InkManifest) -> Result<(), InkError> {
    if manifest.schema_version != INK_BOARD_SCHEMA_VERSION {
        return Err(unsupported_schema());
    }
    if !manifest.pages.is_empty() {
        return Err(invalid_argument(
            "Ink board manifest must not contain fixed pages",
        ));
    }
    match &manifest.source {
        InkSource::Blank {} => {}
        InkSource::Resource { .. } => {
            return Err(invalid_argument(
                "Ink board manifest must use a blank source",
            ))
        }
    }

    validate_id(&manifest.document_id)?;
    validate_revision(&manifest.revision)?;
    validate_title(&manifest.title)?;

    let surface = manifest
        .surface
        .as_ref()
        .ok_or_else(|| invalid_argument("Ink board manifest requires a board surface"))?;
    validate_board_surface(surface)?;

    if manifest.chunks.len() > INK_BOARD_CHUNKS_MAX {
        return Err(limit_exceeded("Ink board manifest exceeds the chunk limit"));
    }

    let mut chunk_ids = HashSet::with_capacity(manifest.chunks.len());
    let mut total_objects: u64 = 0;
    let mut total_samples: u64 = 0;
    let mut total_bytes: u64 = 0;
    for chunk_ref in &manifest.chunks {
        validate_board_chunk_ref(chunk_ref)?;
        if !chunk_ids.insert(chunk_ref.chunk_id.as_str()) {
            return Err(invalid_argument(
                "Ink board manifest contains duplicate chunk IDs",
            ));
        }

        total_objects = total_objects
            .checked_add(chunk_ref.object_count as u64)
            .ok_or_else(|| limit_exceeded("Ink board manifest exceeds the object limit"))?;
        total_samples = total_samples
            .checked_add(chunk_ref.sample_count as u64)
            .ok_or_else(|| limit_exceeded("Ink board manifest exceeds the sample limit"))?;
        total_bytes = total_bytes
            .checked_add(chunk_ref.byte_length)
            .ok_or_else(|| limit_exceeded("Ink board manifest exceeds the content budget"))?;

        if total_objects > INK_BOARD_OBJECTS_MAX as u64 {
            return Err(limit_exceeded(
                "Ink board manifest exceeds the object limit",
            ));
        }
        if total_samples > INK_BOARD_SAMPLES_MAX as u64 {
            return Err(limit_exceeded(
                "Ink board manifest exceeds the sample limit",
            ));
        }
        if total_bytes > INK_BOARD_CONTENT_MAX_BYTES {
            return Err(limit_exceeded(
                "Ink board manifest exceeds the content budget",
            ));
        }
    }

    validate_receipt(manifest)
}
