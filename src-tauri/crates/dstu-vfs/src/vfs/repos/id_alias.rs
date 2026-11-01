//! 持久化 payload 里的 ID 别名解析（原 `data_governance::sync::SyncManager` 的纯 SQL 部分）。
//!
//! vfs 的附件读取需要跟随 `__sync_id_aliases` 找到 canonical 行；这里只依赖 rusqlite，
//! 不依赖 sync 域。`SyncManager` 保留同名方法作为薄包装。

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

/// 快照表是否存在（与旧实现的 SQL 和错误文案一致）。
pub fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        params![table_name],
        |row| row.get(0),
    )
    .map_err(|e| format!("检查快照表是否存在失败: {}", e))
}

/// 沿别名链解析到 canonical ID；检测到循环时降级返回原始 ID（与旧实现一致）。
pub fn resolve_alias_with_lookup<E>(
    table_name: &str,
    record_id: &str,
    mut lookup: impl FnMut(&str) -> Result<Option<String>, E>,
) -> Result<String, E> {
    let mut current = record_id.to_string();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.clone()) {
            tracing::warn!(
                "[sync] ID 别名存在循环，降级使用原始 record_id: {}.{}",
                table_name,
                record_id
            );
            return Ok(record_id.to_string());
        }
        match lookup(&current)? {
            Some(next) => current = next,
            None => return Ok(current),
        }
    }
}

/// 解析持久化 payload 中的 ID 别名；表不存在时原样返回。
pub fn resolve_persisted_id_alias(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
) -> Result<String, String> {
    if !table_exists(conn, "__sync_id_aliases")? {
        return Ok(record_id.to_string());
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT canonical_id FROM __sync_id_aliases
             WHERE table_name = ?1 AND remote_id = ?2",
        )
        .map_err(|e| format!("读取 ID 别名失败: {}", e))?;
    resolve_alias_with_lookup(table_name, record_id, |current| {
        stmt.query_row(params![table_name, current], |row| row.get(0))
            .optional()
            .map_err(|e| format!("读取 ID 别名失败: {}", e))
    })
}
