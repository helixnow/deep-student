//! MCP server list secure settings helpers.
//!
//! Reads/writes `mcp.tools.list` through `Database::get_secret` / `save_secret`,
//! matching the `save_setting` / `get_setting` command layer.

use std::sync::Mutex;

use serde_json::Value;

use crate::database::Database;

pub const MCP_TOOLS_LIST_KEY: &str = "mcp.tools.list";

/// agent 侧写入 `mcp.tools.list` 的进程内互斥锁。
///
/// 该键没有 OCC/版本字段，read-modify-write 之间并发的 propose/update/remove
/// 会互相覆盖；所有 agent 执行器在「读→改→写」临界区内持有本锁（不得跨 await）。
/// Settings UI 的直接写入不经过此锁，仍存在理论竞争窗口（与存量行为一致）。
static MCP_LIST_MUTATION_LOCK: Mutex<()> = Mutex::new(());

pub fn mcp_list_mutation_guard() -> std::sync::MutexGuard<'static, ()> {
    // 持锁线程 panic 后毒化不影响数据正确性，直接恢复继续
    MCP_LIST_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

/// 配置写入落地后通知前端重载 MCP 连接。
///
/// 复用 settings_models 的 `chat_v2://settings_changed` 域事件：前端
/// chatV2DomainEventBridge 会转发为 `systemSettingsChanged`（settingKey 以
/// `mcp.` 开头），main.tsx 据此调用 `bootstrapMcpFromSettings` 重建连接，
/// DialogControlContext / McpPanel 随 `mcp-bootstrap-ready` 刷新展示。
pub fn emit_mcp_list_changed(window: &tauri::Window, action: &str) -> bool {
    use tauri::{Emitter, Manager};
    window
        .app_handle()
        .emit(
            super::settings_models_executor::SETTINGS_CHANGED_EVENT,
            serde_json::json!({ "action": action, "key": MCP_TOOLS_LIST_KEY }),
        )
        .is_ok()
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
