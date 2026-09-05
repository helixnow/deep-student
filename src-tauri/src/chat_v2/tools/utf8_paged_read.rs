use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::executor::DEFAULT_TOOL_RESULT_CHAR_BUDGET;

pub const DEFAULT_READ_MAX_BYTES: u64 = 64 * 1024;
pub const MAX_READ_MAX_BYTES: u64 = 1024 * 1024;
const NOTICE_RESERVE_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utf8Page {
    pub content: String,
    pub offset: usize,
    pub returned_bytes: usize,
    pub next_offset: usize,
    pub eof: bool,
    pub truncated: bool,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn is_continuation_byte(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

pub fn parse_offset(args: &Value) -> Result<usize, String> {
    match args.get("offset") {
        None | Some(Value::Null) => Ok(0),
        Some(value) => {
            let n = value
                .as_u64()
                .ok_or_else(|| "offset must be a non-negative integer".to_string())?;
            usize::try_from(n).map_err(|_| "offset is too large".to_string())
        }
    }
}

pub fn parse_max_bytes(args: &Value) -> Result<usize, String> {
    let Some(value) = args.get("max_bytes") else {
        return Ok(DEFAULT_READ_MAX_BYTES as usize);
    };
    let value = value
        .as_u64()
        .ok_or_else(|| "max_bytes must be a positive integer".to_string())?;
    if !(1..=MAX_READ_MAX_BYTES).contains(&value) {
        return Err(format!(
            "max_bytes must be between 1 and {MAX_READ_MAX_BYTES}"
        ));
    }
    Ok(value as usize)
}

pub fn optional_expected_hash(args: &Value) -> Option<String> {
    args.get("expected_hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

pub fn check_expected_hash(expected: &str, actual: &str) -> Result<(), String> {
    if expected.eq_ignore_ascii_case(actual) {
        Ok(())
    } else {
        Err(format!(
            "expected_hash 不匹配：当前 sha256 为 {actual}。内容可能已变化，请从 offset=0 重新读取。"
        ))
    }
}

pub fn page_utf8_text(text: &str, offset: usize, max_bytes: usize) -> Result<Utf8Page, String> {
    let total = text.len();
    if offset > total {
        return Err(format!("offset {offset} exceeds content length {total}"));
    }
    if offset == total {
        return Ok(Utf8Page {
            content: String::new(),
            offset,
            returned_bytes: 0,
            next_offset: offset,
            eof: true,
            truncated: false,
        });
    }
    if !text.is_char_boundary(offset) {
        return Err(format!("offset {offset} is not a UTF-8 character boundary"));
    }

    let mut end = offset.saturating_add(max_bytes.max(1)).min(total);
    if !text.is_char_boundary(end) {
        end = prev_char_boundary(text, end);
    }
    if end <= offset {
        end = text[offset..]
            .chars()
            .next()
            .map(|ch| offset + ch.len_utf8())
            .unwrap_or(offset);
    }

    let content = text[offset..end].to_string();
    let returned_bytes = content.len();
    let next_offset = offset + returned_bytes;
    let eof = next_offset >= total;
    Ok(Utf8Page {
        content,
        offset,
        returned_bytes,
        next_offset,
        eof,
        truncated: !eof,
    })
}

pub fn decode_utf8_window(bytes: &[u8], more_remains: bool) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(error) if more_remains && error.error_len().is_none() => {
            Ok(String::from_utf8_lossy(&bytes[..error.valid_up_to()]).to_string())
        }
        Err(_) => Err("workspace_file_read currently supports UTF-8 text files only".to_string()),
    }
}

pub fn serialized_char_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.chars().count())
        .unwrap_or(0)
}

pub fn apply_paging_fields(
    output: &mut Value,
    content_key: &str,
    content: &str,
    offset: usize,
    total_bytes: usize,
) {
    let returned_bytes = content.len();
    let next_offset = offset.saturating_add(returned_bytes);
    let eof = next_offset >= total_bytes;
    output[content_key] = json!(content);
    output["offset"] = json!(offset);
    output["returned_bytes"] = json!(returned_bytes);
    output["next_offset"] = json!(next_offset);
    output["eof"] = json!(eof);
    output["truncated"] = json!(!eof);
    if output.get("contentLength").is_some() {
        output["contentLength"] = json!(returned_bytes);
    }
    if output.get("contentTruncated").is_some() {
        output["contentTruncated"] = json!(!eof);
    }
}

pub fn fit_paged_content_to_budget(
    output: &mut Value,
    content_key: &str,
    offset: usize,
    total_bytes: usize,
    budget: usize,
) -> bool {
    let Some(original) = output
        .get(content_key)
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return serialized_char_len(output) <= budget;
    };

    apply_paging_fields(output, content_key, &original, offset, total_bytes);
    if serialized_char_len(output) <= budget {
        return true;
    }

    apply_paging_fields(output, content_key, "", offset, total_bytes);
    if serialized_char_len(output) > budget {
        apply_paging_fields(output, content_key, &original, offset, total_bytes);
        return false;
    }

    let ends: Vec<usize> = original
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(original.len()))
        .collect();
    let mut best = 0usize;
    let mut low = 0usize;
    let mut high = ends.len().saturating_sub(1);
    while low <= high {
        let mid_k = low + (high - low) / 2;
        let mid = ends[mid_k];
        apply_paging_fields(output, content_key, &original[..mid], offset, total_bytes);
        if serialized_char_len(output) <= budget {
            best = mid;
            if mid_k == ends.len() - 1 {
                break;
            }
            low = mid_k + 1;
        } else if mid_k == 0 {
            best = 0;
            break;
        } else {
            high = mid_k - 1;
        }
    }
    if best == 0 && !original.is_empty() {
        apply_paging_fields(output, content_key, &original, offset, total_bytes);
        return false;
    }
    apply_paging_fields(output, content_key, &original[..best], offset, total_bytes);
    true
}

pub fn fit_paged_read_to_default_budget(
    output: &mut Value,
    content_key: &str,
    offset: usize,
    total_bytes: usize,
) -> bool {
    let budget = DEFAULT_TOOL_RESULT_CHAR_BUDGET.saturating_sub(NOTICE_RESERVE_CHARS);
    fit_paged_content_to_budget(output, content_key, offset, total_bytes, budget)
}

fn prev_char_boundary(text: &str, mut index: usize) -> usize {
    if index > text.len() {
        index = text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_rejects_mid_char_offset() {
        let text = "ab你cd";
        let mid = 3;
        assert!(!text.is_char_boundary(mid));
        let err = page_utf8_text(text, mid, 8).unwrap_err();
        assert!(err.contains("character boundary"));
    }

    #[test]
    fn page_rejects_offset_past_eof() {
        let err = page_utf8_text("hi", 3, 8).unwrap_err();
        assert!(err.contains("exceeds"));
    }

    #[test]
    fn page_at_eof_returns_empty_block() {
        let page = page_utf8_text("hi", 2, 8).unwrap();
        assert_eq!(page.content, "");
        assert_eq!(page.returned_bytes, 0);
        assert_eq!(page.next_offset, 2);
        assert!(page.eof);
        assert!(!page.truncated);
    }

    #[test]
    fn page_snaps_end_to_char_boundary_and_makes_progress() {
        let text = "你我";
        let page = page_utf8_text(text, 0, 1).unwrap();
        assert_eq!(page.content, "你");
        assert_eq!(page.returned_bytes, 3);
        assert_eq!(page.next_offset, 3);
        assert!(!page.eof);
    }

    #[test]
    fn expected_hash_is_case_insensitive() {
        let hash = sha256_hex(b"abc");
        check_expected_hash(&hash.to_uppercase(), &hash).unwrap();
        assert!(check_expected_hash("deadbeef", &hash).is_err());
    }

    #[test]
    fn budget_fit_keeps_cursor_on_final_body() {
        let body = "你".repeat(20_000) + &"x".repeat(20_000);
        let mut output = json!({
            "content": body,
            "sha256": "abc",
            "contentLength": body.len(),
            "contentTruncated": false,
        });
        assert!(fit_paged_content_to_budget(
            &mut output,
            "content",
            0,
            body.len(),
            DEFAULT_TOOL_RESULT_CHAR_BUDGET,
        ));
        let content = output["content"].as_str().unwrap();
        assert!(body.starts_with(content));
        assert_eq!(output["returned_bytes"], json!(content.len()));
        assert_eq!(output["next_offset"], json!(content.len()));
        assert_eq!(output["eof"], json!(false));
        assert_eq!(output["truncated"], json!(true));
        assert_eq!(output["contentLength"], json!(content.len()));
        assert_eq!(output["contentTruncated"], json!(true));
        assert!(serialized_char_len(&output) <= DEFAULT_TOOL_RESULT_CHAR_BUDGET);
        assert!(content.len() < body.len());
        let after_outer = crate::chat_v2::tools::executor::apply_tool_result_budget(
            output.clone(),
            DEFAULT_TOOL_RESULT_CHAR_BUDGET,
        );
        assert_eq!(after_outer, output);
    }

    #[test]
    fn successive_pages_reconstruct_full_text() {
        let text = "hello你world";
        let mut offset = 0usize;
        let mut acc = String::new();
        loop {
            let page = page_utf8_text(text, offset, 4).unwrap();
            acc.push_str(&page.content);
            if page.eof {
                break;
            }
            assert_eq!(page.next_offset, offset + page.returned_bytes);
            offset = page.next_offset;
        }
        assert_eq!(acc, text);
    }

    #[test]
    fn parse_offset_and_max_bytes_defaults() {
        let args = json!({});
        assert_eq!(parse_offset(&args).unwrap(), 0);
        assert_eq!(
            parse_max_bytes(&args).unwrap(),
            DEFAULT_READ_MAX_BYTES as usize
        );
        assert!(parse_offset(&json!({"offset": -1})).is_err());
        assert!(parse_max_bytes(&json!({"max_bytes": 0})).is_err());
        assert!(parse_max_bytes(&json!({"max_bytes": MAX_READ_MAX_BYTES + 10})).is_err());
        assert!(parse_max_bytes(&json!({"max_bytes": "4"})).is_err());
    }

    #[test]
    fn budget_fit_refuses_a_non_advancing_page() {
        let body = "你好";
        let mut output = json!({
            "content": body,
            "metadata": "x".repeat(2_000),
        });
        assert!(!fit_paged_content_to_budget(
            &mut output,
            "content",
            0,
            body.len(),
            1_000,
        ));
        assert_eq!(output["content"], body);
        assert_eq!(output["next_offset"], body.len());
    }
}
