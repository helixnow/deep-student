//! `.dsink` 手写/批注格式与验证契约。
//!
//! JSON 使用 snake_case；稳定 ID 是不透明字符串；页面几何坐标为逻辑页坐标，
//! 不是归一化工具坐标。错误消息不得包含原始文件内容或大载荷。

pub mod board;
pub(crate) mod board_operations;
pub mod operations;
pub mod types;
pub mod validate;

#[cfg(test)]
mod operations_tests;
#[cfg(test)]
mod tests;

pub use board::{
    validate_board_bounds, validate_board_chunk, INK_BOARD_CHUNKS_MAX, INK_BOARD_CHUNK_MAX_BYTES,
    INK_BOARD_CHUNK_OBJECTS_MAX, INK_BOARD_CHUNK_SAMPLES_MAX, INK_BOARD_CONTENT_MAX_BYTES,
    INK_BOARD_OBJECTS_MAX, INK_BOARD_SAMPLES_MAX, INK_BOARD_WORLD_LIMIT,
};
pub use operations::{
    apply_operations, undo_operations, InkCoordinateSpace, InkNormalizedPoint, InkNormalizedRect,
    InkObjectChange, InkOperation, InkOperationContent, InkOperationError, InkOperationErrorCode,
    InkOperationsResult, InkRenderMapping,
};
pub use types::{
    InkAuthor, InkBackground, InkBoardBounds, InkBoardChunk, InkBoardChunkRef, InkBoardObject,
    InkBoardSurface, InkError, InkErrorCode, InkManifest, InkObject, InkObjectContent,
    InkOperationReceipt, InkPage, InkPageRef, InkPoint, InkRect, InkRuling, InkSample, InkSource,
    InkStrokeStyle, InkTool, INK_BOARD_SCHEMA_VERSION, INK_EXTENSION, INK_MIME, INK_SCHEMA_VERSION,
};
pub use validate::{validate_manifest, validate_page};

/// manifest JSON byte limit.
pub const INK_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
/// Page JSON byte limit.
pub const INK_PAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Document page count limits.
pub const INK_PAGES_MIN: usize = 1;
pub const INK_PAGES_MAX: usize = 500;
/// Page width and height limits.
pub const INK_DIMENSION_MIN: f64 = 1.0;
pub const INK_DIMENSION_MAX: f64 = 16384.0;
/// Stable ID and revision length limit in Unicode scalar values.
pub const INK_ID_MAX_CHARS: usize = 128;
/// Title length limit in Unicode scalar values.
pub const INK_TITLE_MAX_CHARS: usize = 256;
/// Per-page object and stroke sample limits.
pub const INK_PAGE_OBJECTS_MAX: usize = 10_000;
pub const INK_PAGE_SAMPLES_MAX: usize = 100_000;
pub const INK_STROKE_MIN_SAMPLES: usize = 1;
/// Text length limit in Unicode scalar values.
pub const INK_TEXT_MAX_CHARS: usize = 10_000;
/// Width and font-size limits.
pub const INK_WIDTH_MAX: f64 = 256.0;
pub const INK_FONT_SIZE_MIN: f64 = 1.0;
pub const INK_FONT_SIZE_MAX: f64 = 256.0;

fn invalid_argument(message: &'static str) -> InkError {
    InkError {
        code: InkErrorCode::InvalidArgument,
        message: message.to_owned(),
    }
}

fn parse_error<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<T, InkError> {
    if bytes.len() > max_bytes {
        return Err(InkError {
            code: InkErrorCode::LimitExceeded,
            message: "Ink JSON exceeds the byte limit".to_owned(),
        });
    }

    serde_json::from_slice(bytes).map_err(|_| invalid_argument("Invalid Ink JSON"))
}

/// Parse a manifest, then validate its domain constraints.
pub fn parse_manifest(bytes: &[u8]) -> Result<InkManifest, InkError> {
    // 先做一次只读版本探测：即使未知版本的其余字段形状不合法，也稳定返回
    // UnsupportedSchema，而不是更晚的字段反序列化错误。
    #[derive(serde::Deserialize)]
    struct SchemaProbe {
        schema_version: u32,
    }

    let probe: SchemaProbe = parse_error(bytes, INK_MANIFEST_MAX_BYTES)?;
    if probe.schema_version != INK_SCHEMA_VERSION
        && probe.schema_version != INK_BOARD_SCHEMA_VERSION
    {
        return Err(InkError {
            code: InkErrorCode::UnsupportedSchema,
            message: "Unsupported Ink schema version".to_owned(),
        });
    }

    let manifest: InkManifest = parse_error(bytes, INK_MANIFEST_MAX_BYTES)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Parse a board chunk, then validate it against its manifest reference.
pub fn parse_board_chunk(
    bytes: &[u8],
    chunk_ref: &InkBoardChunkRef,
) -> Result<InkBoardChunk, InkError> {
    let chunk: InkBoardChunk = parse_error(bytes, INK_BOARD_CHUNK_MAX_BYTES)?;
    if bytes.len() as u64 != chunk_ref.byte_length {
        return Err(invalid_argument(
            "Ink board chunk byte length does not match its manifest reference",
        ));
    }
    validate_board_chunk(&chunk, chunk_ref)?;
    Ok(chunk)
}

/// Parse a page and validate it against its manifest reference.
pub fn parse_page(bytes: &[u8], page_ref: &InkPageRef) -> Result<InkPage, InkError> {
    let page = parse_error(bytes, INK_PAGE_MAX_BYTES)?;
    validate_page(&page, page_ref)?;
    Ok(page)
}
