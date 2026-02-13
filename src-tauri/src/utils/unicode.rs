//! Unicode 安全处理工具
//!
//! 提供 Unicode 字符过滤和规范化功能，防止路径遍历和特洛伊木马攻击。

/// ★ BE-06 安全修复：移除 Unicode 特殊字符，防止绕过攻击
///
/// 过滤零宽字符并规范化全角字符为半角，防止：
/// - 零宽字符隐藏恶意内容
/// - 全角斜杠绕过路径验证
/// - 双向文本控制字符（特洛伊木马源码攻击）
/// - 隔离格式字符
#[inline]
pub fn sanitize_unicode(input: &str) -> String {
    input
        .chars()
        .filter(|c| {
            // 过滤零宽字符和不可见操作符
            !matches!(
                c,
                '\u{200B}'  // 零宽空格 (Zero Width Space)
                    | '\u{200C}'  // 零宽非连接符 (Zero Width Non-Joiner)
                    | '\u{200D}'  // 零宽连接符 (Zero Width Joiner)
                    | '\u{FEFF}'  // BOM / 零宽非断空格 (Byte Order Mark)
                    | '\u{00AD}'  // 软连字符 (Soft Hyphen)
                    | '\u{2060}'  // 词连接符 (Word Joiner)
                    | '\u{2061}'..='\u{2064}'  // 不可见操作符 (Invisible Operators)
                    // 双向文本控制字符（防止特洛伊木马源码攻击）
                    | '\u{202A}'..='\u{202E}'  // LRE, RLE, PDF, LRO, RLO
                    // 隔离格式字符
                    | '\u{2066}'..='\u{2069}'  // LRI, RLI, FSI, PDI
            )
        })
        // 规范化全角字符为半角
        .map(|c| match c {
            '／' => '/',  // 全角斜杠 U+FF0F
            '＼' => '\\', // 全角反斜杠 U+FF3C
            '．' => '.',  // 全角点 U+FF0E
            '：' => ':',  // 全角冒号 U+FF1A
            '＊' => '*',  // 全角星号 U+FF0A
            '？' => '?',  // 全角问号 U+FF1F
            '＜' => '<',  // 全角小于 U+FF1C
            '＞' => '>',  // 全角大于 U+FF1E
            '｜' => '|',  // 全角竖线 U+FF5C
            '＂' => '"',  // 全角引号 U+FF02
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_zero_width() {
        assert_eq!(sanitize_unicode("a\u{200B}b"), "ab");
        assert_eq!(sanitize_unicode("test\u{FEFF}"), "test");
        assert_eq!(sanitize_unicode("\u{200C}abc\u{200D}"), "abc");
    }

    #[test]
    fn test_sanitize_fullwidth() {
        assert_eq!(sanitize_unicode("path／to／file"), "path/to/file");
        assert_eq!(sanitize_unicode("file．txt"), "file.txt");
        assert_eq!(sanitize_unicode("C：＼Users"), "C:\\Users");
    }

    #[test]
    fn test_sanitize_bidi() {
        assert_eq!(sanitize_unicode("a\u{202E}b"), "ab");
        assert_eq!(sanitize_unicode("\u{202A}test\u{202C}"), "test");
    }

    #[test]
    fn test_sanitize_isolation() {
        assert_eq!(sanitize_unicode("a\u{2066}b\u{2069}c"), "abc");
    }

    #[test]
    fn test_sanitize_invisible_operators() {
        assert_eq!(sanitize_unicode("a\u{2061}b\u{2062}c"), "abc");
    }

    #[test]
    fn test_sanitize_normal_text() {
        // 正常文本应该保持不变
        assert_eq!(sanitize_unicode("hello world"), "hello world");
        assert_eq!(sanitize_unicode("文件名.txt"), "文件名.txt");
        assert_eq!(sanitize_unicode("/path/to/file"), "/path/to/file");
    }
}
