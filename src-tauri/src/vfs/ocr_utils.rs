//! OCR JSON helpers for VFS
//!
//! Provides compatibility parsing for `ocr_pages_json` stored in different formats:
//! - Legacy: Vec<Option<String>>
//! - Legacy: Vec<String>
//! - Current: OcrPagesJson { pages: [{ page_index, blocks: [{ text, bbox }] }] }

use serde_json::Value;
use tracing::warn;

/// Parse `ocr_pages_json` into a per-page text array.
pub fn parse_ocr_pages_json(json_str: &str) -> Vec<Option<String>> {
    let trimmed = json_str.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    if let Ok(pages) = serde_json::from_str::<Vec<Option<String>>>(trimmed) {
        return pages;
    }

    if let Ok(pages) = serde_json::from_str::<Vec<String>>(trimmed) {
        return pages
            .into_iter()
            .map(|text| {
                let t = text.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(text)
                }
            })
            .collect();
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            warn!("[OcrUtils] Failed to parse ocr_pages_json: {}", e);
            return vec![];
        }
    };

    let pages = match value.get("pages").and_then(|v| v.as_array()) {
        Some(p) => p,
        None => {
            warn!("[OcrUtils] ocr_pages_json has no pages array");
            return vec![];
        }
    };

    let total_pages = value
        .get("total_pages")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .or_else(|| {
            pages
                .iter()
                .filter_map(|p| p.get("page_index").and_then(|v| v.as_u64()))
                .max()
                .map(|v| v as usize + 1)
        })
        .unwrap_or_else(|| pages.len());

    let mut result = vec![None; total_pages.max(pages.len())];

    for (idx, page) in pages.iter().enumerate() {
        let page_index = page
            .get("page_index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(idx);

        let block_text = page
            .get("blocks")
            .and_then(|v| v.as_array())
            .and_then(|blocks| {
                let mut parts: Vec<String> = Vec::new();
                for block in blocks {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        let t = text.trim();
                        if !t.is_empty() {
                            parts.push(t.to_string());
                        }
                    }
                }
                if parts.is_empty() {
                    None
                } else {
                    Some(parts.join("\n"))
                }
            });

        let text_field = page
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let page_text = match (block_text, text_field) {
            (Some(blocks), Some(text)) => {
                if blocks.len() >= text.len() {
                    Some(blocks)
                } else {
                    Some(text)
                }
            }
            (Some(blocks), None) => Some(blocks),
            (None, Some(text)) => Some(text),
            (None, None) => None,
        };

        if page_index >= result.len() {
            result.resize(page_index + 1, None);
        }
        result[page_index] = page_text;
    }

    result
}

/// Join OCR pages into a single text block with page headers.
///
/// `header_prefix` and `header_suffix` allow callers to control localization.
pub fn join_ocr_pages_text(
    pages: &[Option<String>],
    header_prefix: &str,
    header_suffix: &str,
) -> Option<String> {
    join_ocr_pages_text_with_offset(pages, 0, header_prefix, header_suffix)
}

/// Join OCR pages into a single text block with page headers, starting from a given offset.
///
/// `start_offset` is the 0-based index of the first page in the slice,
/// used to compute correct 1-based page numbers in headers.
pub fn join_ocr_pages_text_with_offset(
    pages: &[Option<String>],
    start_offset: usize,
    header_prefix: &str,
    header_suffix: &str,
) -> Option<String> {
    let mut result = String::new();
    for (i, page_text) in pages.iter().enumerate() {
        if let Some(text) = page_text {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !result.is_empty() {
                result.push_str("\n\n");
            }
            result.push_str(&format!(
                "--- {} {} {} ---\n{}",
                header_prefix,
                start_offset + i + 1,
                header_suffix,
                trimmed
            ));
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}
