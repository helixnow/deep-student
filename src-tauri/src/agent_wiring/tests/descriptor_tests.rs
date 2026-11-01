//! ToolDescriptor ↔ 生产执行器花名册同步测试（step 10 §3.3）。
//!
//! 从 `chat_v2::tool_descriptors::tests` 原样搬来（函数名不变）：
//! `production_like_registry` 镜像需要 app 域执行器，chat_v2 搬入 dstu-agent
//! 后只能在 app 侧组装。`EXPECTED_ROSTER` 快照也随之搬来，供
//! `roster_tests` / `legacy_tests` 共用。

use std::collections::HashSet;
use std::sync::Arc;

use crate::chat_v2::automations::trusted_profile_supported_extra_tools;
use crate::chat_v2::headless::{HEADLESS_BLOCKED_TOOLS, LEGACY_HEADLESS_ALLOWED_TOOLS};
use crate::chat_v2::skill_market_client::{
    SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor,
};
use crate::chat_v2::tool_descriptors::{lookup, BUILTIN_DESCRIPTORS};
use crate::chat_v2::tools::executor_registry::ToolExecutorRegistry;
use crate::chat_v2::tools::notes_import_executor::NotesImportExecutor;
use crate::chat_v2::tools::ptc_runtime::PTC_ALLOWED_TOOLS;
use crate::chat_v2::tools::qbank_executor::QBankExecutor;
use crate::chat_v2::tools::role_pack_executor::RolePackExecutor;
use crate::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor;
use crate::chat_v2::tools::self_inspect_executor::SelfInspectExecutor;
use crate::chat_v2::tools::skill_install_executor::SkillInstallExecutor;
use crate::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor;
use crate::chat_v2::tools::{
    AcademicSearchExecutor, AskUserExecutor, AttachmentStageExecutor, AttachmentToolExecutor,
    AttemptCompletionExecutor, AutomationExecutor, BrowserToolExecutor, BuiltinResourceExecutor,
    BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, CodeNavigationExecutor,
    ConnectorToolExecutor, CoordinatorSleepExecutor, CustomAgentExecutor,
    DataGovernanceToolExecutor, DocumentProcessingExecutor, DocxToolExecutor, DstuToolExecutor,
    EssayGradingExecutor, FetchExecutor, FileManagerExecutor, FsrsSettingsExecutor,
    GeneralToolExecutor, GenerativeUiExecutor, GitToolExecutor, GoalExecutor,
    ImageGenerationExecutor, IndexWebpageToolExecutor, InsightRecallExecutor, KnowledgeExecutor,
    LearningOverviewExecutor, LlmUsageToolExecutor, LocalShellExecuteExecutor,
    LocalShellPreflightExecutor, LspNavigationExecutor, McpManageExecutor, McpProposeExecutor,
    MediaToolExecutor, MemoryToolExecutor, OfficeFidelityExecutor, PaperSaveExecutor,
    PptxToolExecutor, PtcExecutor, ReviewToolExecutor, SessionToolExecutor,
    SettingsModelsToolExecutor, SkillLifecycleExecutor, SkillsExecutor, SubagentExecutor,
    SuperSessionExecutor, TaskAuditExecutor, TemplateDesignerExecutor, TextbookPdfToolExecutor,
    TodoListExecutor, ToolExecutor, ToolPackExecutor, TranslationToolExecutor, UserTodoExecutor,
    WorkbenchToolExecutor, WorkspaceFsExecutor, WorkspaceToolExecutor, XlsxToolExecutor,
};
use crate::chat_v2::workspace::WorkspaceCoordinator;

/// 生产等价执行器注册表镜像。
///
/// ⚠️ 与 `agent_wiring::roster::AppExecutorRoster`（+ `assemble_registry` 固定尾部）
/// 保持**同序**镜像（手写第二信源，有意不复用花名册本身）；
/// 新增/删除 executor 时必须同步此处与 `EXPECTED_ROSTER`，否则本防线失效。
fn production_like_registry() -> (tempfile::TempDir, Arc<ToolExecutorRegistry>) {
    let temp = tempfile::tempdir().expect("workspace coordinator temp dir");
    let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));

    let mut executors: Vec<Arc<dyn ToolExecutor>> = vec![
        Arc::new(AttemptCompletionExecutor::new()),
        Arc::new(CanvasToolExecutor::new()),
        Arc::new(ChatAnkiToolExecutor::new()),
        Arc::new(BuiltinRetrievalExecutor::new()),
        Arc::new(InsightRecallExecutor::new()),
        Arc::new(BuiltinResourceExecutor::new()),
        Arc::new(ConnectorToolExecutor::new()),
        Arc::new(TaskAuditExecutor::new()),
        Arc::new(DstuToolExecutor::new()),
        Arc::new(AttachmentToolExecutor::new()),
        Arc::new(FetchExecutor::new()),
        Arc::new(BrowserToolExecutor::new()),
        Arc::new(MediaToolExecutor::new()),
        Arc::new(OfficeFidelityExecutor::new()),
        Arc::new(McpProposeExecutor::new()),
        Arc::new(McpManageExecutor::new()),
        Arc::new(AutomationExecutor::new()),
        Arc::new(AcademicSearchExecutor::new()),
        Arc::new(PaperSaveExecutor::new()),
        Arc::new(KnowledgeExecutor::new()),
        Arc::new(TodoListExecutor::new()),
        Arc::new(GoalExecutor::new()),
        Arc::new(QBankExecutor::new()),
        Arc::new(TranslationToolExecutor::new()),
        Arc::new(SettingsModelsToolExecutor::new()),
        Arc::new(LlmUsageToolExecutor::new()),
        Arc::new(LearningOverviewExecutor::new()),
        Arc::new(FsrsSettingsExecutor::new()),
        Arc::new(DataGovernanceToolExecutor::new()),
        Arc::new(MemoryToolExecutor::new()),
        Arc::new(UserTodoExecutor::new()),
        Arc::new(SkillsExecutor::new()),
        Arc::new(TemplateDesignerExecutor::new()),
        Arc::new(TextbookPdfToolExecutor::new()),
        Arc::new(IndexWebpageToolExecutor::new()),
        Arc::new(AskUserExecutor::new()),
        Arc::new(SessionToolExecutor::new()),
        Arc::new(DocxToolExecutor::new()),
        Arc::new(PptxToolExecutor::new()),
        Arc::new(XlsxToolExecutor::new()),
        Arc::new(ImageGenerationExecutor::new()),
        Arc::new(GenerativeUiExecutor::new()),
        Arc::new(WorkspaceFsExecutor::new()),
        Arc::new(LspNavigationExecutor::new()),
        Arc::new(CodeNavigationExecutor::new()),
        Arc::new(FileManagerExecutor::new()),
        Arc::new(AttachmentStageExecutor::new()),
        Arc::new(NotesImportExecutor::new()),
        Arc::new(SkillInstallExecutor::new()),
        Arc::new(SkillMarketReadToolExecutor::new()),
        Arc::new(SkillMarketInstallToolExecutor::new()),
        Arc::new(SkillWorkshopExecutor::new()),
        Arc::new(SkillLifecycleExecutor::new()),
        Arc::new(LocalShellPreflightExecutor::new()),
        Arc::new(GitToolExecutor::new()),
        Arc::new(SelfInspectExecutor::new()),
        Arc::new(RolePackExecutor::new()),
        Arc::new(RuntimeRootRequestExecutor::new()),
        Arc::new(LocalShellExecuteExecutor::new()),
        Arc::new(EssayGradingExecutor::new()),
        Arc::new(ReviewToolExecutor::new()),
        Arc::new(DocumentProcessingExecutor::new()),
        Arc::new(WorkbenchToolExecutor::new()),
        // —— coordinator 注册组（pipeline.rs workspace 分支）——
        Arc::new(WorkspaceToolExecutor::new(coordinator.clone())),
        Arc::new(SubagentExecutor::new(coordinator.clone())),
        Arc::new(SuperSessionExecutor::new(coordinator.clone())),
        Arc::new(CustomAgentExecutor::new(coordinator.clone())),
        Arc::new(CoordinatorSleepExecutor::new(coordinator)),
    ];

    let registry = Arc::new_cyclic(|weak: &std::sync::Weak<ToolExecutorRegistry>| {
        executors.push(Arc::new(ToolPackExecutor::new(weak.clone())));
        executors.push(Arc::new(PtcExecutor::new()));
        // GeneralToolExecutor 必须最后（catch-all）
        executors.push(Arc::new(GeneralToolExecutor::new()));
        ToolExecutorRegistry::from_vec(executors)
    });
    (temp, registry)
}

/// 与 pipeline.rs 注册顺序一致的 executor 名单快照。
pub(crate) const EXPECTED_ROSTER: &[&str] = &[
    "AttemptCompletionExecutor",
    "CanvasToolExecutor",
    "ChatAnkiToolExecutor",
    "BuiltinRetrievalExecutor",
    "InsightRecallExecutor",
    "BuiltinResourceExecutor",
    "ConnectorToolExecutor",
    "TaskAuditExecutor",
    "DstuToolExecutor",
    "AttachmentToolExecutor",
    "FetchExecutor",
    "BrowserToolExecutor",
    "MediaToolExecutor",
    "OfficeFidelityExecutor",
    "McpProposeExecutor",
    "McpManageExecutor",
    "AutomationExecutor",
    "AcademicSearchExecutor",
    "PaperSaveExecutor",
    "KnowledgeExecutor",
    "TodoListExecutor",
    "GoalExecutor",
    "QBankExecutor",
    "TranslationToolExecutor",
    "SettingsModelsToolExecutor",
    "LlmUsageToolExecutor",
    "LearningOverviewExecutor",
    "FsrsSettingsExecutor",
    "DataGovernanceToolExecutor",
    "MemoryToolExecutor",
    "UserTodoExecutor",
    "SkillsExecutor",
    "TemplateDesignerExecutor",
    "TextbookPdfToolExecutor",
    "IndexWebpageToolExecutor",
    "AskUserExecutor",
    "SessionToolExecutor",
    "DocxToolExecutor",
    "PptxToolExecutor",
    "XlsxToolExecutor",
    "ImageGenerationExecutor",
    "GenerativeUiExecutor",
    "WorkspaceFsExecutor",
    "LspNavigationExecutor",
    "CodeNavigationExecutor",
    "FileManagerExecutor",
    "AttachmentStageExecutor",
    "NotesImportExecutor",
    "SkillInstallExecutor",
    "SkillMarketReadToolExecutor",
    "SkillMarketInstallToolExecutor",
    "SkillWorkshopExecutor",
    "SkillLifecycleExecutor",
    "LocalShellPreflightExecutor",
    "GitToolExecutor",
    "SelfInspectExecutor",
    "RolePackExecutor",
    "RuntimeRootRequestExecutor",
    "LocalShellExecuteExecutor",
    "EssayGradingExecutor",
    "ReviewToolExecutor",
    "DocumentProcessingExecutor",
    "WorkbenchToolExecutor",
    "WorkspaceToolExecutor",
    "SubagentExecutor",
    "SuperSessionExecutor",
    "CustomAgentExecutor",
    "CoordinatorSleepExecutor",
    "ToolPackExecutor",
    "PtcExecutor",
    "GeneralToolExecutor",
];

/// 独立维护的安全清单并集（注册表外的第二信源，缺 descriptor 立即红灯）。
///
/// headless 口径使用 headless.rs 保留的 `#[cfg(test)]` 手写清单 oracle
/// （G01-e 后生产 `headless_allowed_tools()` 由注册表派生，不再独立）。
fn independently_known_tool_names() -> HashSet<String> {
    let mut set = HashSet::new();
    for name in LEGACY_HEADLESS_ALLOWED_TOOLS {
        set.insert((*name).to_string());
    }
    for (name, _reason) in HEADLESS_BLOCKED_TOOLS {
        // `mcp_*` 是通配文档口径，不是具体工具名
        if !name.contains('*') {
            set.insert((*name).to_string());
        }
    }
    for name in PTC_ALLOWED_TOOLS {
        set.insert((*name).to_string());
    }
    for name in trusted_profile_supported_extra_tools() {
        set.insert(name.to_string());
    }
    set
}

/// 方向一（多余 descriptor）：每条 descriptor 必须被某个**特异性** executor
/// 受理（GeneralToolExecutor 兜底不算）。工具从 executor 移除后忘删
/// descriptor 会立即红灯。
#[test]
fn every_descriptor_maps_to_a_specific_executor() {
    let (_temp, registry) = production_like_registry();
    assert_eq!(registry.len(), EXPECTED_ROSTER.len());
    for descriptor in BUILTIN_DESCRIPTORS {
        assert!(
            registry.has_specific_executor(descriptor.name),
            "no specific executor handles descriptor tool: {}",
            descriptor.name
        );
        assert!(
            registry.has_specific_executor(&format!("builtin-{}", descriptor.name)),
            "no specific executor handles builtin-{} ",
            descriptor.name
        );
    }
}

/// 方向二（缺失 descriptor）：独立安全清单里每个被特异性 executor 受理的
/// 工具名必须在注册表恰有一条 descriptor。
///
/// 已知边界：若某 executor 内部私有名单新增工具且未进任何安全清单，
/// 本测试无法感知——新增 executor 应遵循 codebase 惯例暴露
/// `pub mod tool_names` 并把工具加入相应白/黑名单（也会被本清单捕获）。
#[test]
fn independently_known_tools_all_have_descriptors() {
    let (_temp, registry) = production_like_registry();
    for name in independently_known_tool_names() {
        let stripped = name.strip_prefix("builtin-").unwrap_or(name.as_str());
        if !registry.has_specific_executor(stripped) {
            // 清单里的防御性条目（如 anki_generate_cards）无 executor 受理，
            // 无需 descriptor。
            continue;
        }
        assert!(
            lookup(stripped).is_some(),
            "tool '{name}' is handled by an executor and listed in a security list \
             but has no ToolDescriptor (register it in BUILTIN_DESCRIPTORS)"
        );
    }
}

/// executor 花名册快照：镜像构造与 pipeline.rs 注册保持同序。
/// 若 pipeline 新增 executor，需同步 production_like_registry 与本名单。
#[test]
fn executor_roster_matches_pipeline_registration() {
    let (_temp, registry) = production_like_registry();
    let names = registry.executor_names();
    assert_eq!(names, EXPECTED_ROSTER);
}

/// descriptor 的名字级敏感度必须与 executor 自报基线逐工具相等——
/// 注册表不是第二套拍脑袋分级，而是现状的权威镜像。
#[test]
fn descriptor_sensitivity_matches_executor_baseline() {
    let (_temp, registry) = production_like_registry();
    for descriptor in BUILTIN_DESCRIPTORS {
        let actual = registry
            .get_sensitivity(descriptor.name)
            .unwrap_or_else(|| panic!("no executor for {}", descriptor.name));
        assert_eq!(
            actual, descriptor.sensitivity,
            "sensitivity drift for tool {}",
            descriptor.name
        );
    }
}
