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
