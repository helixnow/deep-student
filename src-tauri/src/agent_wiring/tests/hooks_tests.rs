//! 审批 fail-closed × app 域执行器敏感度测试（step 10 §3.3）。
//!
//! 从 `chat_v2::pipeline::hooks::tests` 原样搬来（函数名不变）：用例断言 memory /
//! essay / canvas / dstu / index / learning 等 app 域执行器的非 Low 工具在缺失
//! ApprovalManager 时 fail-closed，chat_v2 搬入 dstu-agent 后只能在 app 侧组装。

use std::sync::Arc;

use crate::chat_v2::pipeline::hooks::approval_manager_required;
use crate::chat_v2::tools::ToolSensitivity;

#[test]
fn phase9_non_low_tools_enter_the_fail_closed_approval_path() {
    use crate::chat_v2::tools::ToolExecutor;

    let memory = crate::chat_v2::tools::MemoryToolExecutor::new();
    let essay = crate::chat_v2::tools::EssayGradingExecutor::new();
    let temp_dir = tempfile::tempdir().expect("create workspace directory");
    let subagent = crate::chat_v2::tools::SubagentExecutor::new(Arc::new(
        crate::chat_v2::workspace::WorkspaceCoordinator::new(temp_dir.path().to_path_buf()),
    ));

    for (tool, sensitivity) in [
        (
            "builtin-memory_batch_move",
            memory.sensitivity_level("builtin-memory_batch_move"),
        ),
        (
            "builtin-memory_add_relation",
            memory.sensitivity_level("builtin-memory_add_relation"),
        ),
        (
            "builtin-memory_remove_relation",
            memory.sensitivity_level("builtin-memory_remove_relation"),
        ),
        (
            "builtin-memory_update_tags",
            memory.sensitivity_level("builtin-memory_update_tags"),
        ),
        (
            "builtin-memory_export_all",
            memory.sensitivity_level("builtin-memory_export_all"),
        ),
        (
            "builtin-essay_grade",
            essay.sensitivity_level("builtin-essay_grade"),
        ),
        (
            "builtin-subagent_call",
            subagent.sensitivity_level("builtin-subagent_call"),
        ),
    ] {
        assert_ne!(sensitivity, ToolSensitivity::Low, "{tool}");
        assert!(
            approval_manager_required(Some(sensitivity)),
            "{tool} must be blocked when ApprovalManager is unavailable"
        );
    }

    assert!(!approval_manager_required(Some(
        essay.sensitivity_level("builtin-essay_list_modes")
    )));
}

#[test]
fn phase2_phase3_and_phase8_non_low_tools_fail_closed_without_approval_manager() {
    use crate::chat_v2::tools::ToolExecutor;

    let canvas = crate::chat_v2::tools::CanvasToolExecutor::new();
    let dstu = crate::chat_v2::tools::DstuToolExecutor::new();
    let session = crate::chat_v2::tools::SessionToolExecutor::new();
    let index = crate::chat_v2::tools::IndexWebpageToolExecutor::new();

    let cases = [
        (
            "builtin-note_delete",
            canvas.sensitivity_level("builtin-note_delete"),
        ),
        (
            "builtin-note_update_tags",
            canvas.sensitivity_level("builtin-note_update_tags"),
        ),
        (
            "builtin-dstu_folder_create",
            dstu.sensitivity_level("builtin-dstu_folder_create"),
        ),
        (
            "builtin-dstu_folder_rename",
            dstu.sensitivity_level("builtin-dstu_folder_rename"),
        ),
        (
            "builtin-dstu_rename",
            dstu.sensitivity_level("builtin-dstu_rename"),
        ),
        (
            "builtin-dstu_move",
            dstu.sensitivity_level("builtin-dstu_move"),
        ),
        (
            "builtin-dstu_delete",
            dstu.sensitivity_level("builtin-dstu_delete"),
        ),
        (
            "builtin-dstu_restore",
            dstu.sensitivity_level("builtin-dstu_restore"),
        ),
        (
            "builtin-dstu_purge",
            dstu.sensitivity_level("builtin-dstu_purge"),
        ),
        (
            "builtin-dstu_upload_file",
            dstu.sensitivity_level("builtin-dstu_upload_file"),
        ),
        (
            "builtin-session_export",
            session.sensitivity_level("builtin-session_export"),
        ),
        (
            "builtin-session_tag_add",
            session.sensitivity_level("builtin-session_tag_add"),
        ),
        (
            "builtin-session_tag_remove",
            session.sensitivity_level("builtin-session_tag_remove"),
        ),
        (
            "builtin-session_move",
            session.sensitivity_level("builtin-session_move"),
        ),
        (
            "builtin-session_rename",
            session.sensitivity_level("builtin-session_rename"),
        ),
        (
            "builtin-session_restore",
            session.sensitivity_level("builtin-session_restore"),
        ),
        (
            "builtin-group_create",
            session.sensitivity_level("builtin-group_create"),
        ),
        (
            "builtin-group_update",
            session.sensitivity_level("builtin-group_update"),
        ),
        (
            "builtin-session_archive",
            session.sensitivity_level("builtin-session_archive"),
        ),
        (
            "builtin-index_rebuild",
            index.sensitivity_level("builtin-index_rebuild"),
        ),
        (
            "builtin-webpage_save",
            index.sensitivity_level("builtin-webpage_save"),
        ),
    ];
    for (tool, sensitivity) in cases {
        assert_ne!(sensitivity, ToolSensitivity::Low, "{tool}");
        assert!(
            approval_manager_required(Some(sensitivity)),
            "{tool} must be blocked when ApprovalManager is unavailable"
        );
    }

    let learning = crate::chat_v2::tools::LearningOverviewExecutor::new();
    for tool in [
        "builtin-learning_overview",
        "builtin-pomodoro_today_stats",
        "builtin-pomodoro_daily_stats",
    ] {
        assert_eq!(
            learning.sensitivity_level(tool),
            ToolSensitivity::Low,
            "{tool}"
        );
        assert!(!approval_manager_required(Some(
            learning.sensitivity_level(tool)
        )));
    }
}
