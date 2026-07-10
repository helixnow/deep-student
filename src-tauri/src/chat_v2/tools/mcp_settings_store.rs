//! MCP server list secure settings helpers.
//!
//! Reads/writes `mcp.tools.list` through `Database::get_secret` / `save_secret`,
//! matching the `save_setting` / `get_setting` command layer.

use serde_json::Value;

use crate::database::Database;

pub const MCP_TOOLS_LIST_KEY: &str = "mcp.tools.list";

/// Read the MCP server list from secure store (empty array when unset).
pub fn read_mcp_tools_list(db: &Database) -> Result<Vec<Value>, String> {
    let raw = db
        .get_secret(MCP_TOOLS_LIST_KEY)
        .map_err(|e| format!("failed to read {}: {}", MCP_TOOLS_LIST_KEY, e))?;
    match raw {
        None => Ok(Vec::new()),
        Some(value) if value.trim().is_empty() => Ok(Vec::new()),
        Some(value) => {
            let parsed: Value = serde_json::from_str(&value)
                .map_err(|e| format!("failed to parse {} JSON: {}", MCP_TOOLS_LIST_KEY, e))?;
            match parsed {
                Value::Array(items) => Ok(items),
                _ => Err(format!("{} is not a JSON array", MCP_TOOLS_LIST_KEY)),
            }
        }
    }
}

/// Persist the MCP server list through secure store.
pub fn write_mcp_tools_list(db: &Database, list: &[Value]) -> Result<(), String> {
    let serialized = serde_json::to_string(list)
        .map_err(|e| format!("failed to serialize {}: {}", MCP_TOOLS_LIST_KEY, e))?;
    db.save_secret(MCP_TOOLS_LIST_KEY, &serialized)
        .map_err(|e| format!("failed to write {}: {}", MCP_TOOLS_LIST_KEY, e))
}

/// Restore a prior list snapshot (used for rollback after failed connection tests).
pub fn restore_list_snapshot(snapshot: &[Value]) -> Vec<Value> {
    snapshot.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restore_list_snapshot_clones_entries() {
        let snapshot = vec![json!({"id": "a", "name": "a"})];
        let restored = restore_list_snapshot(&snapshot);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].get("id").and_then(Value::as_str), Some("a"));
    }
}
