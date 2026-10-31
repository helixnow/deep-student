//! 自定义 agent 档案 × chatanki 只读工具测试（step 10 §3.3）。
//!
//! 从 `chat_v2::workspace::custom_agents::tests` 原样搬来（函数名不变）：用例
//! 需要 app 的 `ChatAnkiToolExecutor` 钉死只读四工具的敏感度。

use std::path::Path;

use crate::chat_v2::workspace::custom_agents::{
    find_custom_profile, safe_tool_set, CHATANKI_READONLY_TOOLS,
};

/// 与 `chat_v2::workspace::custom_agents::tests::write_agent_file` 相同的测试辅助。
fn write_agent_file(dir: &Path, filename: &str, content: &str) {
    std::fs::write(dir.join(filename), content).expect("write agent definition file");
}

/// Multi-agent Phase 2 双向 fail-closed 之「放行」向：chatanki 只读四工具
/// 进入安全全集，档案声明后完整保留；且四者确实是 chatanki 执行器口径的
/// Low 敏感度只读工具（防止未来有人把写工具塞进该常量）。
#[test]
fn chatanki_readonly_tools_are_allowed_and_low_sensitivity() {
    let safe = safe_tool_set();
    for tool in CHATANKI_READONLY_TOOLS {
        assert!(safe.contains(tool), "safe tool set must contain {tool}");
    }

    // 常量本身的只读性由执行器敏感度分级钉死：四者全部 Low。
    use crate::chat_v2::tools::executor::{ToolExecutor, ToolSensitivity};
    let executor = crate::chat_v2::tools::ChatAnkiToolExecutor::new();
    for tool in CHATANKI_READONLY_TOOLS {
        assert!(executor.can_handle(tool), "{tool} must be a chatanki tool");
        assert_eq!(
            executor.sensitivity_level(tool),
            ToolSensitivity::Low,
            "{tool} must stay Low sensitivity to qualify as read-only card surface"
        );
    }

    let dir = tempfile::tempdir().unwrap();
    write_agent_file(
        dir.path(),
        "qa-readonly.md",
        "---\nname: qa-readonly\nbase: worker\ntools: [builtin-chatanki_get_cards, builtin-chatanki_status, builtin-chatanki_analyze, builtin-chatanki_list_templates]\n---\nBody.\n",
    );
    let profile = find_custom_profile(dir.path(), "qa-readonly").unwrap();
    assert_eq!(
        profile.allowed_tools,
        vec![
            "builtin-workspace_send",
            "builtin-workspace_query",
            "builtin-chatanki_get_cards",
            "builtin-chatanki_status",
            "builtin-chatanki_analyze",
            "builtin-chatanki_list_templates",
        ]
    );
}
