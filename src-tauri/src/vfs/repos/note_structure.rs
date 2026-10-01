//! Root Markdown spans shared by format validation, transfer and history slicing.
//! The WP11 directive is parsed as an indivisible, strictly versioned container.
use super::note_format_repo::invalid;
use crate::vfs::error::VfsResult;
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::ops::Range;

#[derive(Debug)]
pub(crate) struct RootSpan {
    pub range: Range<usize>,
    pub paragraph: bool,
    pub columns: bool,
}

fn markdown_roots(content: &str) -> Vec<RootSpan> {
    let mut result = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    let mut paragraph = false;
    for (event, range) in Parser::new_ext(content, Options::all()).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    start = range.start;
                    paragraph = matches!(tag, Tag::Paragraph);
                }
                depth += 1;
            }
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    result.push(RootSpan {
                        range: start..range.end,
                        paragraph,
                        columns: false,
                    });
                }
            }
            _ if depth == 0 => result.push(RootSpan {
                range,
                paragraph: false,
                columns: false,
            }),
            _ => {}
        }
    }
    result
}

fn delimiter<'a>(root: &RootSpan, content: &'a str) -> Option<&'a str> {
    let text = content[root.range.clone()].trim_end_matches(['\n', '\r']);
    (root.paragraph && !text.contains('\n') && text.starts_with(":::")).then_some(text)
}
fn reserved(text: &str) -> bool {
    text.starts_with(":::ds-columns")
        || text.starts_with(":::column")
        || text.starts_with(":::end-column")
        || text.starts_with(":::end-ds-columns")
}

pub(crate) fn roots(content: &str) -> VfsResult<Vec<RootSpan>> {
    let raw = markdown_roots(content);
    let mut result = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let token = delimiter(&raw[i], content);
        if token.is_some_and(|v| v.starts_with(":::ds-columns")) {
            if !matches!(
                token,
                Some(
                    ":::ds-columns{version=1 layout=equal}"
                        | ":::ds-columns{version=1 layout=cornell}"
                )
            ) {
                return Err(invalid("Unsupported ds-columns version or layout"));
            }
            let start = raw[i].range.start;
            i += 1;
            for _ in 0..2 {
                if raw.get(i).and_then(|r| delimiter(r, content)) != Some(":::column") {
                    return Err(invalid("Columns must contain exactly two columns"));
                }
                i += 1;
                loop {
                    let root = raw
                        .get(i)
                        .ok_or_else(|| invalid("Unclosed ds-columns container"))?;
                    let token = delimiter(root, content);
                    if token == Some(":::end-column") {
                        i += 1;
                        break;
                    }
                    if token.is_some_and(reserved) {
                        return Err(invalid("Nested or malformed column delimiter"));
                    }
                    i += 1;
                }
            }
            if raw.get(i).and_then(|r| delimiter(r, content)) != Some(":::end-ds-columns") {
                return Err(invalid("Missing ds-columns end or extra column"));
            }
            result.push(RootSpan {
                range: start..raw[i].range.end,
                paragraph: false,
                columns: true,
            });
            i += 1;
        } else {
            if token.is_some_and(reserved) {
                return Err(invalid("Column delimiter outside a container"));
            }
            let root = &raw[i];
            result.push(RootSpan {
                range: root.range.clone(),
                paragraph: root.paragraph,
                columns: false,
            });
            i += 1;
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "note_columns_tests.rs"]
mod tests;
