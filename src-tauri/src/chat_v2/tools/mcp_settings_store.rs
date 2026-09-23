//! MCP server list secure settings helpers.
//!
//! Reads/writes `mcp.tools.list` through `Database::get_secret` / `save_secret`,
//! matching the `save_setting` / `get_setting` command layer.

use std::sync::Mutex;

use serde_json::Value;

use crate::database::Database;

pub const MCP_TOOLS_LIST_KEY: &str = "mcp.tools.list";

/// 选项 ①：全局"MCP 危险模式"开关。
///
/// 存储为独立的 secure key（不放进 `mcp.tools.list`），避免被批准门自己污染。
/// 值为字符串 "true" / 其他视为 false。默认 false（严格模式）。
///
/// 开启后 `mcp_stdio_start` 跳过 `validate_stdio_start_against_entries`，
/// 任何 (command, args, env, cwd, framing) 都会被直接 spawn —— WebView 里的
/// 任意 JS（含第三方依赖）都能借此 RCE。必须仅在用户明确知情的情况下开启。
pub const MCP_ALLOW_UNAPPROVED_KEY: &str = "mcp.stdio.allowUnapproved";

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

/// 读取"MCP 危险模式"开关。默认 false。
pub fn read_mcp_allow_unapproved(db: &Database) -> Result<bool, String> {
    let raw = db
        .get_secret(MCP_ALLOW_UNAPPROVED_KEY)
        .map_err(|e| format!("failed to read {}: {}", MCP_ALLOW_UNAPPROVED_KEY, e))?;
    Ok(parse_allow_unapproved_value(raw.as_deref()))
}

/// 写入"MCP 危险模式"开关。
pub fn write_mcp_allow_unapproved(db: &Database, enabled: bool) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    db.save_secret(MCP_ALLOW_UNAPPROVED_KEY, value)
        .map_err(|e| format!("failed to write {}: {}", MCP_ALLOW_UNAPPROVED_KEY, e))
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

    /// 选项 ① 回归：read_mcp_allow_unapproved 在未写入时必须默认为 false，
    /// 大小写不敏感地识别 "true"，其他值一律视为 false。
    #[test]
    fn read_mcp_allow_unapproved_defaults_false_and_parses_true_case_insensitive() {
        // 这里用一个轻量的 in-memory fake Database 即可，但 Database 是项目重量级类型。
        // 直接验证解析逻辑：抽出共用的判别函数更可测，但目前函数内嵌，改为通过
        // 逻辑等价测试——构造一个仅暴露 get_secret/save_secret 的最小 mock 太侵入，
        // 因此把"解析 true" 的判断逻辑抽成独立函数单独测试（见下方 helper）。
        assert!(parse_allow_unapproved_value(Some("true")));
        assert!(parse_allow_unapproved_value(Some("TRUE")));
        assert!(parse_allow_unapproved_value(Some(" True \n")));
        assert!(!parse_allow_unapproved_value(Some("false")));
        assert!(!parse_allow_unapproved_value(Some("1")));
        assert!(!parse_allow_unapproved_value(Some("yes")));
        assert!(!parse_allow_unapproved_value(Some("")));
        assert!(!parse_allow_unapproved_value(None));
    }
}

/// 抽出供单元测试的纯解析逻辑。公开 crate 内可见即可。
pub(crate) fn parse_allow_unapproved_value(raw: Option<&str>) -> bool {
    match raw {
        None => false,
        Some(v) => v.trim().eq_ignore_ascii_case("true"),
    }
}
