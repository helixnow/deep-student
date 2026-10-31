//! 执行器花名册测试（step 10）。
//!
//! - `test_*_registered_before_general_executor` 等 17 个用例从
//!   `chat_v2::pipeline::tests` 原样搬来（函数名不变），改为对 app 生产花名册
//!   `AppExecutorRoster` + `assemble_registry` 断言；
//! - 新增花名册 oracle：注入后的注册表必须与 `EXPECTED_ROSTER` 逐项同序。

use std::sync::Arc;

use crate::agent_wiring::roster::{missing_descriptor_tools, AppExecutorRoster};
use crate::chat_v2::pipeline::{
    assemble_registry, ChatV2Pipeline, CoreExecutorRoster, ExecutorRoster,
};
use crate::chat_v2::tools::ToolExecutorRegistry;
use crate::chat_v2::workspace::WorkspaceCoordinator;

use super::descriptor_tests::EXPECTED_ROSTER;

/// 拆分前 `ChatV2Pipeline::create_executor_registry()`：生产花名册、无 workspace coordinator。
fn create_executor_registry() -> Arc<ToolExecutorRegistry> {
    assemble_registry(AppExecutorRoster.executors(None))
}

fn temp_coordinator() -> (tempfile::TempDir, Arc<WorkspaceCoordinator>) {
    let temp = tempfile::tempdir().expect("workspace coordinator temp dir");
    let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));
    (temp, coordinator)
}

/// 迁移完备的临时库 + 真实 Pipeline（与 `chat_v2::pipeline::tests` 的 harness 同构）。
fn test_pipeline() -> (tempfile::TempDir, tempfile::TempDir, ChatV2Pipeline) {
    use crate::chat_v2::database::ChatV2Database;
    use crate::data_governance::migration::coordinator::MigrationCoordinator;
    use crate::data_governance::schema_registry::DatabaseId;
    use crate::database::Database;
    use crate::file_manager::FileManager;
    use crate::llm_manager::LLMManager;
    use crate::tools::ToolRegistry;

    let chat_dir = tempfile::TempDir::new().expect("chat temp");
    let mut coordinator =
        MigrationCoordinator::new(chat_dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::ChatV2)
        .expect("chat_v2 migrate");
    let chat_db = Arc::new(ChatV2Database::new(chat_dir.path()).expect("chat db"));

    let main_dir = tempfile::TempDir::new().expect("main temp");
    let mut main_coordinator =
        MigrationCoordinator::new(main_dir.path().to_path_buf()).with_audit_db(None);
    main_coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("main migrate");
    let main_db = Arc::new(Database::new(&main_dir.path().join("mistakes.db")).expect("main db"));
    let file_manager =
        Arc::new(FileManager::new(main_dir.path().join("app-data")).expect("file manager"));
    let llm_manager =
        Arc::new(LLMManager::new(main_db.clone(), file_manager).expect("llm manager"));

    let pipeline = ChatV2Pipeline::new(
        chat_db,
        Some(main_db),
        None,
        None,
        llm_manager,
        Arc::new(ToolRegistry::new()),
        None,
    );
    (chat_dir, main_dir, pipeline)
}

/// 花名册 oracle：app 注入的完整花名册（含 coordinator 组）+ 固定尾部 == `EXPECTED_ROSTER`。
#[test]
fn app_executor_roster_matches_expected_roster() {
    let (_temp, coordinator) = temp_coordinator();
    let registry = assemble_registry(AppExecutorRoster.executors(Some(&coordinator)));
    assert_eq!(registry.executor_names(), EXPECTED_ROSTER);
}

/// 无 coordinator 时（`ChatV2Pipeline::new` 之后、`with_workspace_coordinator` 之前）
/// 只少 coordinator 注册组，其余顺序不变。
#[test]
fn app_executor_roster_without_workspace_omits_only_coordinator_group() {
    const COORDINATOR_GROUP: &[&str] = &[
        "WorkspaceToolExecutor",
        "SubagentExecutor",
        "CustomAgentExecutor",
        "CoordinatorSleepExecutor",
    ];
    let expected: Vec<&str> = EXPECTED_ROSTER
        .iter()
        .copied()
        .filter(|name| !COORDINATOR_GROUP.contains(name))
        .collect();
    assert_eq!(create_executor_registry().executor_names(), expected);
}

/// `CoreExecutorRoster` 是 app 花名册的保序子序列（agent 自有执行器的相对顺序不变）。
#[test]
fn core_executor_roster_is_ordered_subsequence_of_app_roster() {
    let (_temp, coordinator) = temp_coordinator();
    for workspace in [None, Some(&coordinator)] {
        let app: Vec<&str> = AppExecutorRoster
            .executors(workspace)
            .iter()
            .map(|executor| executor.name())
            .collect();
        let core: Vec<&str> = CoreExecutorRoster
            .executors(workspace)
            .iter()
            .map(|executor| executor.name())
            .collect();
        assert!(!core.is_empty());
        let mut app_iter = app.iter();
        for name in &core {
            assert!(
                app_iter.any(|candidate| candidate == name),
                "CoreExecutorRoster entry {name} is missing or out of order in AppExecutorRoster"
            );
        }
    }
}

/// 启动期自检口径：生产注册表覆盖全部 descriptor；只有 core 花名册时能被检出。
#[test]
fn roster_coverage_guard_flags_missing_domain_executors() {
    let (_temp, coordinator) = temp_coordinator();
    let production = assemble_registry(AppExecutorRoster.executors(Some(&coordinator)));
    assert_eq!(missing_descriptor_tools(&production), Vec::<&str>::new());

    let core_only = assemble_registry(CoreExecutorRoster.executors(Some(&coordinator)));
    let missing = missing_descriptor_tools(&core_only);
    assert!(
        !missing.is_empty(),
        "core-only registry must be flagged by the roster guard"
    );
    assert!(core_only.len() < production.len());
}

/// `with_executor_roster` 与 `with_workspace_coordinator` 的调用先后不影响最终花名册。
#[test]
fn executor_roster_injection_is_builder_order_independent() {
    let (_temp, coordinator) = temp_coordinator();

    let (_chat_a, _main_a, pipeline) = test_pipeline();
    let roster_first = pipeline
        .with_executor_roster(Arc::new(AppExecutorRoster))
        .with_workspace_coordinator(coordinator.clone());
    assert_eq!(
        roster_first.executor_registry().executor_names(),
        EXPECTED_ROSTER
    );

    let (_chat_b, _main_b, pipeline) = test_pipeline();
    let coordinator_first = pipeline
        .with_workspace_coordinator(coordinator)
        .with_executor_roster(Arc::new(AppExecutorRoster));
    assert_eq!(
        coordinator_first.executor_registry().executor_names(),
        EXPECTED_ROSTER
    );
}

#[test]
fn test_tool_pack_registered_before_general_executor() {
    let registry = create_executor_registry();
    // Directly verify that the executor matched for tool_pack is ToolPackExecutor
    let executor = registry
        .get_executor("builtin-tool_pack")
        .expect("builtin-tool_pack must have a registered executor");
    assert_eq!(
        executor.name(),
        "ToolPackExecutor",
        "ToolPackExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_workspace_fs_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-workspace_file_read")
        .expect("builtin-workspace_file_read must have a registered executor");
    assert_eq!(
        executor.name(),
        "WorkspaceFsExecutor",
        "WorkspaceFsExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_code_navigation_registered_before_general_executor() {
    let registry = create_executor_registry();
    for tool_name in [
        "builtin-workspace_text_search",
        "builtin-workspace_symbol_outline",
    ] {
        let executor = registry
            .get_executor(tool_name)
            .expect("code navigation tool must have a registered executor");
        assert_eq!(executor.name(), "CodeNavigationExecutor");
    }
}

#[test]
fn test_lsp_navigation_registered_before_general_executor() {
    let registry = create_executor_registry();
    for tool_name in [
        "builtin-workspace_lsp_definition",
        "builtin-workspace_lsp_references",
        "builtin-workspace_lsp_hover",
        "builtin-workspace_lsp_document_symbols",
    ] {
        let executor = registry
            .get_executor(tool_name)
            .expect("LSP navigation tool must have a registered executor");
        assert_eq!(executor.name(), "LspNavigationExecutor");
    }
}

#[test]
fn test_external_mcp_workspace_name_bypasses_builtin_executor() {
    let registry = create_executor_registry();
    for tool_name in ["mcp_workspace_file_read", "mcp.tools.workspace_file_read"] {
        let executor = registry
            .get_executor(tool_name)
            .expect("external MCP tools must route through the general bridge");
        assert_eq!(
            executor.name(),
            "GeneralToolExecutor",
            "external MCP tools must not collide with WorkspaceFsExecutor"
        );
    }
}

#[test]
fn test_attachment_stage_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-attachment_stage")
        .expect("builtin-attachment_stage must have a registered executor");
    assert_eq!(
        executor.name(),
        "AttachmentStageExecutor",
        "AttachmentStageExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_local_shell_preflight_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-local_shell_preflight")
        .expect("builtin-local_shell_preflight must have a registered executor");
    assert_eq!(
        executor.name(),
        "LocalShellPreflightExecutor",
        "LocalShellPreflightExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_self_inspect_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-self_inspect")
        .expect("builtin-self_inspect must have a registered executor");
    assert_eq!(
        executor.name(),
        "SelfInspectExecutor",
        "SelfInspectExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_skill_install_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-skill_scan")
        .expect("builtin-skill_scan must have a registered executor");
    assert_eq!(
        executor.name(),
        "SkillInstallExecutor",
        "SkillInstallExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_skill_market_tools_registered_before_general_executor() {
    let registry = create_executor_registry();
    let search = registry
        .get_executor("builtin-skill_market_search")
        .expect("builtin-skill_market_search must have a registered executor");
    assert_eq!(search.name(), "SkillMarketReadToolExecutor");
    let detail = registry
        .get_executor("builtin-skill_market_skill_detail")
        .expect("builtin-skill_market_skill_detail must have a registered executor");
    assert_eq!(detail.name(), "SkillMarketReadToolExecutor");
    // 写操作不得由只读执行器承接
    let download = registry
        .get_executor("builtin-skill_market_download_and_scan")
        .expect("builtin-skill_market_download_and_scan must have a registered executor");
    assert_eq!(download.name(), "SkillMarketInstallToolExecutor");
    let verify = registry
        .get_executor("builtin-skill_market_verify")
        .expect("builtin-skill_market_verify must have a registered executor");
    assert_eq!(verify.name(), "SkillMarketInstallToolExecutor");
}

#[test]
fn test_skill_workshop_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-skill_workshop_propose")
        .expect("builtin-skill_workshop_propose must have a registered executor");
    assert_eq!(
        executor.name(),
        "SkillWorkshopExecutor",
        "SkillWorkshopExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_skill_lifecycle_registered_before_general_executor() {
    let registry = create_executor_registry();
    for tool in [
        "builtin-skill_set_enabled",
        "builtin-skill_remove",
        "builtin-skill_trust_request",
    ] {
        let executor = registry
            .get_executor(tool)
            .unwrap_or_else(|| panic!("{tool} must have a registered executor"));
        assert_eq!(
            executor.name(),
            "SkillLifecycleExecutor",
            "SkillLifecycleExecutor must be matched before GeneralToolExecutor for {tool}"
        );
    }
}

#[test]
fn test_mcp_propose_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-mcp_server_propose")
        .expect("builtin-mcp_server_propose must have a registered executor");
    assert_eq!(
        executor.name(),
        "McpProposeExecutor",
        "McpProposeExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_mcp_manage_registered_before_general_executor() {
    let registry = create_executor_registry();
    // 裸名 mcp_server_* 若落到 GeneralToolExecutor 会被误当外部 MCP 工具转发，
    // 因此带前缀与裸名两种形态都必须命中 McpManageExecutor
    for tool in [
        "builtin-mcp_server_update",
        "mcp_server_update",
        "builtin-mcp_server_set_enabled",
        "mcp_server_set_enabled",
        "builtin-mcp_server_remove",
        "mcp_server_remove",
    ] {
        let executor = registry
            .get_executor(tool)
            .unwrap_or_else(|| panic!("{tool} must have a registered executor"));
        assert_eq!(
            executor.name(),
            "McpManageExecutor",
            "McpManageExecutor must be matched before GeneralToolExecutor for {tool}"
        );
    }
}

#[test]
fn test_automation_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-automation_propose")
        .expect("builtin-automation_propose must have a registered executor");
    assert_eq!(
        executor.name(),
        "AutomationExecutor",
        "AutomationExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_runtime_root_request_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-runtime_root_request")
        .expect("builtin-runtime_root_request must have a registered executor");
    assert_eq!(
        executor.name(),
        "RuntimeRootRequestExecutor",
        "RuntimeRootRequestExecutor must be matched before GeneralToolExecutor"
    );
}

#[test]
fn test_local_shell_execute_registered_before_general_executor() {
    let registry = create_executor_registry();
    let executor = registry
        .get_executor("builtin-local_shell_execute")
        .expect("builtin-local_shell_execute must have a registered executor");
    assert_eq!(
        executor.name(),
        "LocalShellExecuteExecutor",
        "LocalShellExecuteExecutor must be matched before GeneralToolExecutor"
    );
}
