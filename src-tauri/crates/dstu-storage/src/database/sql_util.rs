//! 与具体表无关的 SQL 辅助函数（主库与 VFS 各 repo 共用）。

/// 转义 SQL LIKE 模式中的通配符(`%`、`_` 与转义符自身),
/// 使用户搜索词按字面匹配;SQL 端必须配合 `ESCAPE '\'`。
/// 各 repo 搜索路径统一用本函数,不要各自实现。
pub fn escape_like_pattern(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
