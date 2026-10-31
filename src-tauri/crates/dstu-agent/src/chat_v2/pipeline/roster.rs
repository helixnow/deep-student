//! 执行器花名册注入点（step 10 §2.2）。
//!
//! 生产花名册（含 38 个域执行器）由 app 的 `agent_wiring::roster::AppExecutorRoster`
//! 提供，经 [`ChatV2Pipeline::with_executor_roster`](super::ChatV2Pipeline::with_executor_roster)
//! 注入；固定尾部（ToolPack(Weak) → Ptc → General）与 `validate_legacy_registry` 仍由
//! pipeline 的 [`assemble_registry`](super::assemble_registry) 统一追加。分发继续走旧
//! `ToolExecutorRegistry`（first-wins `can_handle`），因此花名册顺序就是分发顺序。

use std::sync::Arc;

use crate::chat_v2::tools::ToolExecutor;
use crate::chat_v2::workspace::WorkspaceCoordinator;

/// 有序执行器花名册：固定尾部（ToolPack、Ptc、General）之前的全部执行器。
pub trait ExecutorRoster: Send + Sync {
    /// Ordered executors placed before the fixed tail (ToolPack, Ptc, General).
    /// Must reproduce the exact production order (first `can_handle` wins).
    ///
    /// `workspace` 为 `Some` 时追加 coordinator 注册组（Workspace / Subagent /
    /// CustomAgent / CoordinatorSleep），与拆分前 `with_workspace_coordinator` 一致。
    fn executors(
        &self,
        workspace: Option<&Arc<WorkspaceCoordinator>>,
    ) -> Vec<Arc<dyn ToolExecutor>>;
}

/// agent 自有执行器子集（不含任何域执行器），相对顺序与生产花名册一致。
///
/// `ChatV2Pipeline::new` 的默认值；生产由 app 注入 `AppExecutorRoster` 覆盖。
/// 只用于未注入花名册的单元测试 pipeline——这些测试不分发域工具。
pub struct CoreExecutorRoster;

impl ExecutorRoster for CoreExecutorRoster {
    fn executors(
        &self,
        workspace: Option<&Arc<WorkspaceCoordinator>>,
    ) -> Vec<Arc<dyn ToolExecutor>> {
        use crate::chat_v2::tools;

        let mut executors: Vec<Arc<dyn ToolExecutor>> = Vec::new();

        executors.push(Arc::new(tools::AttemptCompletionExecutor::new()));
        executors.push(Arc::new(tools::ConnectorToolExecutor::new()));
        executors.push(Arc::new(tools::TaskAuditExecutor::new()));
        executors.push(Arc::new(tools::FetchExecutor::new()));
        executors.push(Arc::new(tools::McpProposeExecutor::new()));
        executors.push(Arc::new(tools::McpManageExecutor::new()));
        executors.push(Arc::new(tools::AutomationExecutor::new()));
        executors.push(Arc::new(tools::TodoListExecutor::new()));
        executors.push(Arc::new(tools::GoalExecutor::new()));
        executors.push(Arc::new(tools::LlmUsageToolExecutor::new()));
        executors.push(Arc::new(tools::SkillsExecutor::new()));
        executors.push(Arc::new(tools::AskUserExecutor::new()));
        executors.push(Arc::new(tools::SessionToolExecutor::new()));
        executors.push(Arc::new(tools::WorkspaceFsExecutor::new()));
        executors.push(Arc::new(tools::LspNavigationExecutor::new()));
        executors.push(Arc::new(tools::CodeNavigationExecutor::new()));
        executors.push(Arc::new(tools::FileManagerExecutor::new()));
        executors.push(Arc::new(
            tools::attachment_stage_executor::AttachmentStageExecutor::new(),
        ));
        executors.push(Arc::new(
            tools::skill_install_executor::SkillInstallExecutor::new(),
        ));
        executors.push(Arc::new(
            crate::chat_v2::skill_market_client::SkillMarketReadToolExecutor::new(),
        ));
        executors.push(Arc::new(
            crate::chat_v2::skill_market_client::SkillMarketInstallToolExecutor::new(),
        ));
        executors.push(Arc::new(
            tools::skill_workshop_executor::SkillWorkshopExecutor::new(),
        ));
        executors.push(Arc::new(
            tools::skill_lifecycle_executor::SkillLifecycleExecutor::new(),
        ));
        executors.push(Arc::new(tools::LocalShellPreflightExecutor::new()));
        executors.push(Arc::new(tools::GitToolExecutor::new()));
        executors.push(Arc::new(
            tools::self_inspect_executor::SelfInspectExecutor::new(),
        ));
        executors.push(Arc::new(tools::role_pack_executor::RolePackExecutor::new()));
        executors.push(Arc::new(
            tools::runtime_root_request_executor::RuntimeRootRequestExecutor::new(),
        ));
        executors.push(Arc::new(tools::LocalShellExecuteExecutor::new()));
        executors.push(Arc::new(tools::WorkbenchToolExecutor::new()));

        if let Some(coordinator) = workspace {
            executors.push(Arc::new(tools::WorkspaceToolExecutor::new(
                coordinator.clone(),
            )));
            executors.push(Arc::new(tools::SubagentExecutor::new(coordinator.clone())));
            executors.push(Arc::new(tools::CustomAgentExecutor::new(
                coordinator.clone(),
            )));
            executors.push(Arc::new(tools::CoordinatorSleepExecutor::new(
                coordinator.clone(),
            )));
        }

        executors
    }
}
