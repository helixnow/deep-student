//! 文本转义纯函数（`chat_v2::vfs_resolver` 按原路径重导出）

/// 转义 XML 内容
pub fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
