//! 文本相关的安全工具函数
//!
//! 提供 UTF-8 安全的截断与预览能力，避免字节级切片导致 panic

/// 按字符安全截断字符串，若超过则追加省略号
///
/// - `input`: 待处理文本
/// - `max_chars`: 最大字符数
/// - 返回处理后的新字符串
pub fn safe_truncate(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let mut result = String::with_capacity(max_chars.min(input.len()) + 3);
    let mut iter = input.chars();

    for _ in 0..max_chars {
        match iter.next() {
            Some(ch) => result.push(ch),
            None => return result,
        }
    }

    if iter.next().is_some() {
        result.push_str("...");
    }

    result
}

/// 按字符安全截断字符串但不追加省略号
pub fn safe_truncate_chars(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    input.chars().take(max_chars).collect()
}

/// 获取字符串前 `max_chars` 个字符，超出时追加省略号
pub fn preview_with_ellipsis(input: &str, max_chars: usize) -> String {
    safe_truncate(input, max_chars)
}
