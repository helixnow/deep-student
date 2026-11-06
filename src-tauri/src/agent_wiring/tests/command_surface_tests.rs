//! 命令面守卫测试（step 10 §3.2 / §3.3）。
//!
//! 从 `chat_v2::handlers::block_actions::tests` 原样搬来（函数名不变）：用例
//! `include_str!` app 的 `lib.rs` 与 `permissions/application-commands.toml`，
//! chat_v2 搬入 dstu-agent 后只能留在 app。
//!
//! L5 已把 `block_actions.rs` / `handlers/mod.rs`（命令重导出清单）搬到 `crates/dstu-agent`，
//! 下方两条 `include_str!` 已同步（`lib.rs` 与 permissions 路径不变）。

#[test]
fn removed_cardforge_callback_stays_off_command_surfaces() {
    let removed_command = ["chat_v2_anki", "_cards_result"].concat();
    let command_surfaces = [
        (
            "block_actions.rs",
            include_str!("../../../crates/dstu-agent/src/chat_v2/handlers/block_actions.rs"),
        ),
        (
            "handlers/mod.rs",
            include_str!("../../../crates/dstu-agent/src/chat_v2/handlers/mod.rs"),
        ),
        ("lib.rs", include_str!("../../lib.rs")),
        (
            "permissions/application-commands.toml",
            include_str!("../../../permissions/application-commands.toml"),
        ),
    ];

    for (path, source) in command_surfaces {
        assert!(
            !source.contains(&removed_command),
            "removed CardAgent callback must not be restored in {path}"
        );
    }
}

/// 生成式 UI 交互作答命令须同时出现在命令重导出、`generate_handler!` 与 ACL 白名单。
#[test]
fn genui_interaction_commands_are_registered_on_all_command_surfaces() {
    let commands = [
        "chat_v2_genui_submit_answer",
        "chat_v2_genui_dismiss_answer",
        "chat_v2_genui_list_pending_answers",
    ];
    let lib_rs = include_str!("../../lib.rs");
    let handlers_mod = include_str!("../../../crates/dstu-agent/src/chat_v2/handlers/mod.rs");
    let permissions = include_str!("../../../permissions/application-commands.toml");

    for command in commands {
        assert!(
            lib_rs.contains(&format!(
                "crate::chat_v2::handlers::genui_interaction_handlers::{command}"
            )),
            "{command} must be registered in lib.rs generate_handler!"
        );
        assert!(
            handlers_mod.contains(command),
            "{command} must be re-exported from chat_v2::handlers"
        );
        assert!(
            permissions.contains(&format!("\"{command}\"")),
            "{command} must be allowed in permissions/application-commands.toml"
        );
    }
}
